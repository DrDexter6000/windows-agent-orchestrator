// test/run-lifecycle/boundReadSweep.test.js
//
// R14（2026-08-18，TD-128/129）：读绑定清扫包 —— R13/R13-C 修掉 retry/resume/stop
// 三 lane 后剩余同类无绑定读取的收尾探针与回归。
//
// R16（2026-08-18，TD-127/TD-128 收口）：runCollect lane（R13 起 Owner 级"不改"
// 的最后一处无绑定生命周期读取）—— Owner 2026-08-18 拍板不兼容信封前老数据
// （本机实测存量 0）后放行。:184 session.created → findLatestBound（末条序，
// serveUrl/sessionId 整体重定向面）；:242 run.started → findFirstBound（首条
// 纪律，serve fetch 的 directory 参数重定向面）。漏网清点：文件内 findLatest
// 恰好这两处、无 events.find；相邻非同类面（reconstructItemsFromEvents 的
// run.event 无绑定 filter 是 M12-3 SSOT、defaultAppendFn 的 events[0] 取首行）
// 不在本轮 class 内，见交付报告。
//
// 覆盖面（与 src 改动一一对应）：
//   W1a sessionReuse.js —— resolveReuseTurn 的前任 run session.created 存在性
//       检查改 findLatestBound（绑定到前任 runId）。【唯一 LIVE 修复】：该函数
//       没有 extractCanonicalAgentId 上游门，外 run/无信封尾条真能翻转
//       reuse 路由（crashed-pre-conversation 的前任被读成 resumable）。
//       legacy 明示选择：降级跳过（→ first，不复用无法归属的会话）。
//   W1b runCorrection.js —— correctable 门改 findFirstBound。锚点复核：step 2 的
//       extractCanonicalAgentId 已把任何外 run/无信封行 fail-closed 成
//       unknown_run，交换是纪律一致性 + 纵深防御（行为逐字节不变），探针钉
//       【分层真相】而非虚构"修复前可利用"。
//   W1c runContinue.js —— lineage 门改 findLatestBound。同上：step 3 的身份门
//       先拒（parent_not_found），交换为函数内纪律一致性；钉分层真相 +
//       全绑定输入下末条语义回归。
//   W1d runActivity.js —— backend 事实改 findLatestBound。assertEventsBoundToRunId
//       上游已 throw，交换行为恒等；钉末条语义 + 上游 fail-closed 不变量。
//   W2  commands/shared.js loadRun —— join 前 isValidRunId（delivery.js SSOT）。
//   R15（2026-08-18，TD-128 findState 族；R14 验收会审 coder_mm 对抗席 P1）：
//       sessionReuse.js 三处 findState 前任状态投影改绑定过滤
//       （resolveReuseTurn / resolveLineageFirstTurn /
//       resolveLineageContinuationTurn——各自绑定到槽位前任 entry.runId，
//       runDelivery.js:364 同款范式）。findState 末条胜出语义下 append-only
//       外 run run.state_change 尾条修复前可现实翻转 busy/resume/first 路由
//       （P4：在飞前任 + 伪 completed 尾 → resume = 同一 provider 会话被并发
//       驱动，违反该文件自身 Contract 6）。探针 P4/P5/P6/P6b + 全无信封前任
//       语义钉（不可归属 = 在飞 busy）。合法路径回归 = 既有 m11-11c/m12-7
//       套件全绿（正常 transcript 每行带 runId 信封 → 过滤器恒等）。
//
// 诚实边界（对齐 transcript.js 绑定读取器口径）：绑定只杀跨 run 注入/错读；
// 同 runId 追加伪造 = runs/ 写权限攻击面，读侧无解。本文件全部探针只验跨 run/
// 无信封形状。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { JsonlTranscript, readTranscript, findState } from "../../src/transcript.js";
import { collectRunMessages } from "../../src/application/runCollect.js";
import { resolveReuseTurn, resolveLineageFirstTurn, resolveLineageContinuationTurn } from "../../src/application/sessionReuse.js";
import { correctRun } from "../../src/application/runCorrection.js";
import { continueRun } from "../../src/application/runContinue.js";
import { readRunActivity } from "../../src/application/runActivity.js";
import { loadRun } from "../../src/commands/shared.js";
// R20（TD-128 末簇收口）：M1-M4 / M6-:2080 / M7 / L3 / L4 探针的被测面。
import { getRunStatus } from "../../src/application/runStatus.js";
import { listRuns, extractRunFacts } from "../../src/application/runList.js";
// R20-C（终审返工）：runsCommand（SIGINT 快照探针）/ runsDashboardCommand
// （--latest 排序键探针）为被测面。
import { buildDashboard, runsCommand, runsDashboardCommand } from "../../src/commands/runs.js";
import { getRunDiagnosis } from "../../src/application/runDiagnosis.js";
import { diagnoseFailure } from "../../src/diagnosis.js";
import { scanResumableRuns, scanAllRuns, handleRequest } from "../../src/daemon.js";
import { runBackground, runMain } from "../../src/backgroundRunner.js";
// R18（TD-128 W1/W2/W3 观测面卫生包）：被测面 + CLI 探针用的 runCommand 导出。
import { loadScorecardFromTranscript } from "../../src/commands/run.js";
import { runAwaitResult } from "../../src/application/runAwaitResult.js";
// R19（TD-128 廉价尾巴清扫）：runWait 状态投影绑定探针。
// R20-C（TD-128 终审返工）：summarizeLiveness 进度计数绑定探针。
import { runWait, summarizeLiveness } from "../../src/application/runWait.js";
import { stopRun } from "../../src/application/runStop.js";
import { RunManager } from "../../src/runManager.js";

// ----- helpers -----

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name t", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

/** 追加一条外 run 信封的伪造尾行（append-only transcript 的跨 run 注入形状）。 */
function appendForeignLine(filePath, event) {
  appendFileSync(filePath, `${JSON.stringify({ ts: "2026-08-18T00:00:00.500Z", seq: 99, ...event })}\n`, "utf8");
}

// =====================================================================
// W1a sessionReuse — LIVE 修复探针（该 lane 无上游身份门）
// =====================================================================

test("R14-SR-1: 篡改探针 — 前任 run 无自身 session.created 时，外 run 尾条 session.created 不再翻转 reuse 路由（first 而非 resume）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r14-sr1-"));
  try {
    // 第一次调用为前任 run 认领复用槽位（同 m11-11c TURN 系列结构）。
    await resolveReuseTurn({
      runDir: dir, runId: "run_prior_1", leadSession: "lead-A",
      workspace: "D:/proj", agentId: "researcher",
    });
    // 前任 terminal、从未写过自己的 session.created（crashed pre-conversation）。
    const t = new JsonlTranscript(join(dir, "run_prior_1.jsonl"), { runId: "run_prior_1", agentId: "researcher" });
    await t.transitionState(null, "pending", "seed");
    await t.transitionState("pending", "completed", "seed_done");
    // 尾部追加外 run 伪造 session.created（修复前 findLatest 采信其存在性 → resume）。
    appendForeignLine(t.filePath, {
      type: "session.created", runId: "run_evil", agentId: "researcher",
      backend: "process", backendSessionId: "proc_evil",
    });

    const decision = await resolveReuseTurn({
      runDir: dir, runId: "run_new_1", leadSession: "lead-A",
      workspace: "D:/proj", agentId: "researcher",
    });
    assert.equal(decision.kind, "first", "绑定读取器找不到前任 run 的 session.created → 降级 first（外 run 尾条不采信）");
    assert.equal(decision.routing.turn, "first");
  } finally { cleanupDir(dir); }
});

test("R14-SR-2: 对照 — 前任 run 自身有绑定 session.created 时，外 run 尾条不干扰 resume 判定", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r14-sr2-"));
  try {
    await resolveReuseTurn({
      runDir: dir, runId: "run_prior_2", leadSession: "lead-B",
      workspace: "D:/proj", agentId: "researcher",
    });
    const t = new JsonlTranscript(join(dir, "run_prior_2.jsonl"), { runId: "run_prior_2", agentId: "researcher" });
    await t.transitionState(null, "pending", "seed");
    await t.append("session.created", { backend: "process", backendSessionId: "proc_1" });
    await t.transitionState("pending", "completed", "seed_done");
    appendForeignLine(t.filePath, {
      type: "session.created", runId: "run_evil", agentId: "researcher",
      backend: "process", backendSessionId: "proc_evil",
    });

    const decision = await resolveReuseTurn({
      runDir: dir, runId: "run_new_2", leadSession: "lead-B",
      workspace: "D:/proj", agentId: "researcher",
    });
    assert.equal(decision.kind, "resume", "绑定 session.created 存在 → resume（外 run 尾条既不夺走也不伪造该事实）");
    assert.equal(decision.routing.turn, "resume");
  } finally { cleanupDir(dir); }
});

test("R14-SR-3: legacy 明示选择 — 无信封（事件无 runId 字段）的 session.created 不再触发 resume，降级 first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r14-sr3-"));
  try {
    await resolveReuseTurn({
      runDir: dir, runId: "run_prior_3", leadSession: "lead-C",
      workspace: "D:/proj", agentId: "researcher",
    });
    const t = new JsonlTranscript(join(dir, "run_prior_3.jsonl"), { runId: "run_prior_3", agentId: "researcher" });
    await t.transitionState(null, "pending", "seed");
    await t.transitionState("pending", "completed", "seed_done");
    // pre-envelope legacy 形状：session.created 行存在但无 runId 字段（修复前
    // findLatest 采信 → resume；这是 W1 四处中唯一的 legacy 行为变更）。
    appendFileSync(t.filePath, `${JSON.stringify({
      type: "session.created", agentId: "researcher",
      backend: "process", backendSessionId: "proc_1", ts: "2026-08-18T00:00:00.300Z", seq: 3,
    })}\n`, "utf8");

    const decision = await resolveReuseTurn({
      runDir: dir, runId: "run_new_3", leadSession: "lead-C",
      workspace: "D:/proj", agentId: "researcher",
    });
    assert.equal(decision.kind, "first",
      "legacy 无信封 → 绑定读取器无匹配 → 走既有『terminal 无 session.created』分支降级 first（不复用无法归属的会话；拒绝会不成比例地阻断派发）");
    assert.equal(decision.routing.turn, "first");
  } finally { cleanupDir(dir); }
});

// =====================================================================
// W1b runCorrection — 分层真相钉（上游身份门先拒，correctable 门不可达伪造行）
// =====================================================================

// 最小 correctable-run transcript：bound background_submitted（默认无 correctable
// 事实）+ live-provider 状态。cwd 指向真实 git repo（ownership 证明需要）。
async function seedCorrectionRun(dir, runId, { correctable = false } = {}) {
  makeGitRepo(dir);
  const t = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "coder_hq" });
  await t.append("run.background_submitted", {
    background: true, cwd: dir, deliveryRequested: true,
    ...(correctable ? { correctable: true } : {}),
  });
  await t.transitionState(null, "pending", "background_spawned");
  await t.append("session.created", { backend: "process", backendSessionId: "proc_1" });
  await t.append("run.started", { backend: "claude-code", cwd: dir, worktreePath: dir, worktreeBranch: "wao/x" });
  await t.transitionState("pending", "submitted", "spawned");
  return t;
}

test("R14-CR-1: 分层钉 — 带 correctable:true 的外 run 尾条 background_submitted 在身份门被拒（unknown_run），永不抵达 correctable 门", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r14-cr1-"));
  try {
    const t = await seedCorrectionRun(dir, "run_cr_1", { correctable: false });
    // 伪造"开门"行：本 run 非 correctable，外 run 尾条自称 correctable（若能抵达
    // :149 的无绑定读取，修复前 findLatest 会采信它开门）。
    appendForeignLine(t.filePath, {
      type: "run.background_submitted", runId: "run_evil", agentId: "coder_hq",
      background: true, cwd: dir, deliveryRequested: true, correctable: true,
    });

    const res = await correctRun({
      runId: "run_cr_1", correctionId: "corr_1", prompt: "fix",
      runDir: dir, authorizedWorkspaceRoot: dir,
    });
    // 锚点复核事实：step 2 的 extractCanonicalAgentId(events, runId) 对任何外 run/
    // 无信封行返回 "unknown" → unknown_run，先于 correctable 门。R14 的
    // findFirstBound 交换因此是行为恒等的纪律一致性（防未来身份门放宽）。
    assert.equal(res.outcome, "rejected");
    assert.equal(res.reason, "unknown_run", "身份门先拒——伪造 correctable 行不可达 correctable 门（分层不变量，身份门放宽时本测试变红强制重估）");
  } finally { cleanupDir(dir); }
});

test("R14-CR-2: 合法路径回归 — 绑定的 background_submitted 无 correctable 事实 → not_correctable（首条绑定读取）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r14-cr2-"));
  try {
    await seedCorrectionRun(dir, "run_cr_2", { correctable: false });
    const res = await correctRun({
      runId: "run_cr_2", correctionId: "corr_2", prompt: "fix",
      runDir: dir, authorizedWorkspaceRoot: dir,
    });
    assert.equal(res.outcome, "rejected");
    assert.equal(res.reason, "not_correctable", "非 correctable 派发拒绝进 correction 门（findFirstBound 取到绑定事实）");
  } finally { cleanupDir(dir); }
});

// =====================================================================
// W1c runContinue — 分层真相钉 + 全绑定末条语义回归
// =====================================================================

// 最小 continuable-parent transcript：bound lineage 事实 + terminal；不含
// session.created（使合法路径停在 no_provider_session，证明 lineage 门已通过）。
async function seedLineageParent(dir, runId) {
  mkdirSync(dir, { recursive: true });
  const t = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "coder_hq" });
  await t.append("run.background_submitted", { background: true, cwd: dir, deliveryRequested: true });
  await t.transitionState(null, "pending", "background_spawned");
  await t.append("run.session_reuse", { mode: "run_lineage", turn: "first", rootRunId: runId });
  await t.transitionState("pending", "completed", "done");
  return t;
}

function continueRequest(dir, parentRunId) {
  return {
    parentRunId, prompt: "fix it",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
    runDir: dir, registryPath: join(dir, "agents.json"),
    authorizedWorkspaceRoot: dir, leadSession: "lead-r14",
  };
}

test("R14-CT-1: 合法路径回归 — 绑定 lineage 事实被末条绑定读取器采信，lineage 门通过（停在 no_provider_session）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r14-ct1-"));
  try {
    await seedLineageParent(dir, "run_ct_1");
    const r = await continueRun(continueRequest(dir, "run_ct_1"));
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "no_provider_session",
      "lineage 门通过（findLatestBound 采信绑定 run.session_reuse）→ 走到 session.created 检查");
  } finally { cleanupDir(dir); }
});

test("R14-CT-2: 分层钉 — 外 run 尾条 run.session_reuse 在身份门被拒（parent_not_found），不可达 lineage 门", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r14-ct2-"));
  try {
    const t = await seedLineageParent(dir, "run_ct_2");
    appendForeignLine(t.filePath, {
      type: "run.session_reuse", runId: "run_evil", agentId: "coder_hq",
      mode: "run_lineage", turn: "resume", rootRunId: "run_evil",
    });
    const r = await continueRun(continueRequest(dir, "run_ct_2"));
    // 锚点复核事实：step 3 的 extractCanonicalAgentId 对外 run 行返回 "unknown"
    // → parent_not_found，先于 :347 的 lineage 读取（m12-7 RC-13 同层证据）。
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "parent_not_found",
      "身份门先拒——外 run lineage 尾条不可达 lineage 门（身份门放宽时本测试变红强制重估）");
  } finally { cleanupDir(dir); }
});

test("R14-CT-3: 全绑定末条语义 — 多条绑定 run.session_reuse 时取末条（与非绑定 findLatest 在全绑定输入上恒等）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r14-ct3-"));
  try {
    const t = await seedLineageParent(dir, "run_ct_3");
    // 再追加一条【绑定】但 mode 不同的 run.session_reuse（全绑定 → 身份门放行，
    // 语义由 lineage 读取器的取条顺序决定：末条胜出 → not_continuable）。
    await t.append("run.session_reuse", { mode: "lead_workspace", turn: "resume" });
    const r = await continueRun(continueRequest(dir, "run_ct_3"));
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "not_continuable",
      "末条绑定事件（mode=lead_workspace）胜出 → not_continuable——绑定交换保留既有末条序语义");
  } finally { cleanupDir(dir); }
});

// =====================================================================
// W1d runActivity — 末条语义 + 上游 fail-closed 不变量
// =====================================================================

test("R14-AC-1: backend 事实取末条绑定 session.created；无匹配降级 unknown（报告面宽容）；外 run/无信封行在上游 throw", async () => {
  const bound = (over = {}) => ({
    type: "run.submitted", runId: "run_ac_1", agentId: "coder_low",
    ts: "2026-08-18T00:00:00.000Z", seq: 1, ...over,
  });
  const reader = async (events) => await readRunActivity({
    runId: "run_ac_1", runDir: "unused-with-injected-reader", readTranscriptFn: async () => events,
  });

  // (a) 末条绑定胜出（latest-session-wins，与 stop 面绑定查找同序语义）。
  const snapA = await reader([
    bound(),
    bound({ type: "session.created", backend: "process", backendSessionId: "proc_a", seq: 2 }),
    bound({ type: "session.created", backend: "opencode-serve", backendSessionId: "srv_b", seq: 3 }),
  ]);
  assert.equal(snapA.backend, "opencode-serve", "末条绑定 session.created 的 backend 胜出");

  // (b) 无 session.created → "unknown"（报告面既有降级不变）。
  const snapB = await reader([bound()]);
  assert.equal(snapB.backend, "unknown", "无 session.created → unknown（?. 宽容链保留）");

  // (c) 外 run / 无信封行：assertEventsBoundToRunId 上游 throw（该 lane 的
  //     fail-closed 门在快照边界——:73 的绑定读取因此行为恒等，无 legacy 选择可声明）。
  await assert.rejects(
    () => reader([
      bound(),
      { type: "session.created", backend: "process", backendSessionId: "proc_evil", runId: "run_evil", seq: 2 },
    ]),
    /runId binding failed/,
    "外 run 信封在快照边界 fail-closed，永不抵达 backend 推导");
  await assert.rejects(
    () => reader([
      bound(),
      { type: "session.created", backend: "process", backendSessionId: "proc_legacy", seq: 2 },
    ]),
    /runId binding failed/,
    "无信封 legacy 行同样在快照边界 fail-closed");
});

// =====================================================================
// W2 loadRun 输入校验（TD-128c）
// =====================================================================

test("R14-LR-1: loadRun 拒绝穿越/注入形状的 runId（fixed-safe 文案，不回显输入），合法 id 照常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r14-lr1-"));
  try {
    // 合法 transcript 落盘（raw 行，带信封——loadRun 只读不校验信封）。
    const legalId = "run_legal_ok-1";
    writeFileSync(join(dir, `${legalId}.jsonl`), `${JSON.stringify({
      type: "run.submitted", runId: legalId, agentId: "coder_low",
      ts: "2026-08-18T00:00:00.000Z", seq: 1,
    })}\n`, "utf8");

    // (a) 穿越与注入形状全部拒绝（修复前直接进 join(runDir, runId + ".jsonl")）。
    const malicious = [
      "../evil",            // 上跳
      "..",                 // 纯上跳段
      "a/b",                // 正斜杠分段
      "a\\b",               // 反斜杠分段（Windows 路径分隔符）
      "C:\\evil\\x",        // 绝对盘符路径
      "/abs/x",             // 绝对 posix 路径
      ".hidden",            // 前导点（git ref 规则）
      "-flag",              // 前导横线（option 注入面）
      "has space",          // 空白
      "run;rm",             // shell 元字符
      "run&x",              // shell 元字符
    ];
    for (const bad of malicious) {
      await assert.rejects(
        () => loadRun(bad, { runDir: dir }, {}),
        (e) => {
          assert.match(e.message, /runId is malformed/, `拒绝形状 ${JSON.stringify(bad)}`);
          // fixed-safe：不回显输入值。
          assert.equal(e.message.includes(bad), false, "文案不得回显被拒输入");
          return true;
        },
      );
    }
    // 空值走既有 required 文案（空串 falsy）。
    await assert.rejects(() => loadRun("", { runDir: dir }, {}), /runId is required/);
    await assert.rejects(() => loadRun(undefined, { runDir: dir }, {}), /runId is required/);

    // (b) 合法 id 照常：读回落盘事件并构造 transcript 句柄。
    const { transcript, events } = await loadRun(legalId, { runDir: dir }, {});
    assert.equal(events.length, 1, "合法 id 读回落盘事件");
    assert.equal(transcript.context.runId, legalId, "句柄绑定请求的 runId");

    // (c) 超长：delivery.js 的 isValidRunId SSOT 无长度上限（字符集合法即放行），
    //     本测试钉 SSOT 现状——超长字符集合法 id 通过校验、在文件读取处 ENOENT。
    //     在 loadRun 另造长度帽会分叉 SSOT 校验器（已登记报告给 Lead 裁定）。
    const overlong = "x".repeat(200);
    await assert.rejects(
      () => loadRun(overlong, { runDir: dir }, {}),
      (e) => {
        assert.equal(e.code, "ENOENT", "超长字符集合法 id 通过 SSOT 校验，止步于文件不存在");
        assert.doesNotMatch(e.message, /runId is malformed/);
        return true;
      },
    );
  } finally { cleanupDir(dir); }
});

// =====================================================================
// R15 sessionReuse findState 族 —— LIVE 修复探针（coder_mm 对抗席 P4/P5/P6/P6b）
//
// 三处前任状态投影此前是无绑定 findState(events)：findLatestIndex 是数组序
// 末条胜出（transcript.js），append-only 外 run run.state_change 尾条直接赢
// 得门判。每个探针的"修复前"行为都经末条胜出语义可推（与 W1a 的 R14 探针
// 同一诚实口径：不虚构不可达路径）。
// =====================================================================

test("R15-SR-P4: 篡改探针 — 在飞前任（绑定 session.created + 非终态）+ 外 run 尾条 completed 不再翻转 reuse 路由（busy 保持）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r15-p4-"));
  try {
    // 第一次调用为前任认领复用槽位（同 m11-11c TURN 系列结构）。
    await resolveReuseTurn({
      runDir: dir, runId: "run_prior_p4", leadSession: "lead-P4",
      workspace: "D:/proj", agentId: "researcher",
    });
    // 前任在飞：绑定 session.created + 非终态（submitted）。
    const t = new JsonlTranscript(join(dir, "run_prior_p4.jsonl"), { runId: "run_prior_p4", agentId: "researcher" });
    await t.transitionState(null, "pending", "seed");
    await t.append("session.created", { backend: "process", backendSessionId: "proc_p4" });
    await t.transitionState("pending", "submitted", "spawned");
    // 尾部外 run 伪造 completed。修复前 findState 末条胜出 → 读成 terminal →
    // 前任自身有绑定 session.created → resume：同一 provider 会话被并发驱动
    // （Contract 6 现实违反——coder_mm 探针 P4，非理论）。
    appendForeignLine(t.filePath, {
      type: "run.state_change", runId: "run_evil", agentId: "researcher",
      to: "completed", from: "submitted", reason: "evil",
    });

    const decision = await resolveReuseTurn({
      runDir: dir, runId: "run_new_p4", leadSession: "lead-P4",
      workspace: "D:/proj", agentId: "researcher",
    });
    assert.equal(decision.kind, "busy",
      "绑定过滤后状态只由前任自身事件计算 → 非终态保持 busy（外 run 尾条不采信，不再翻成 resume）");
    assert.equal(decision.activeRunId, "run_prior_p4");
  } finally { cleanupDir(dir); }
});

test("R15-SR-P5: 反向探针 — 终态前任（绑定 session.created + completed）+ 外 run 尾条伪 running 不再阻断派发（resume 恢复）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r15-p5-"));
  try {
    await resolveReuseTurn({
      runDir: dir, runId: "run_prior_p5", leadSession: "lead-P5",
      workspace: "D:/proj", agentId: "researcher",
    });
    // 前任合法可续接：绑定 session.created + 终态 completed。
    const t = new JsonlTranscript(join(dir, "run_prior_p5.jsonl"), { runId: "run_prior_p5", agentId: "researcher" });
    await t.transitionState(null, "pending", "seed");
    await t.append("session.created", { backend: "process", backendSessionId: "proc_p5" });
    await t.transitionState("pending", "completed", "done");
    // 尾部外 run 伪 running。修复前末条胜出 → 非终态 → busy：合法 resume 被
    // 阻断（派发 DoS 面——coder_mm 探针 P5）。
    appendForeignLine(t.filePath, {
      type: "run.state_change", runId: "run_evil", agentId: "researcher",
      to: "running", from: "completed", reason: "evil",
    });

    const decision = await resolveReuseTurn({
      runDir: dir, runId: "run_new_p5", leadSession: "lead-P5",
      workspace: "D:/proj", agentId: "researcher",
    });
    assert.equal(decision.kind, "resume",
      "绑定过滤后取前任自身 completed → 正常 resume（伪 running 尾条不采信，不再误拒）");
    assert.equal(decision.routing.turn, "resume");
  } finally { cleanupDir(dir); }
});

test("R15-SR-LEGACY: 全无信封前任 transcript（零绑定事件）→ 状态不可归属按在飞处理（busy），不再降级 first（R15 语义选择钉）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r15-legacy-"));
  try {
    await resolveReuseTurn({
      runDir: dir, runId: "run_prior_leg", leadSession: "lead-LEG",
      workspace: "D:/proj", agentId: "researcher",
    });
    // pre-envelope legacy 形状：所有行均无 runId 字段（含终态 state_change 与
    // session.created）。R14 时无绑定 findState 读到 completed → terminal →
    // findLatestBound 无匹配 → 降级 first；R15 绑定后过滤为零事件 →
    // findState([]) = "pending" → busy（不可归属 = 在飞，永不并发驱动——
    // 与 R14-SR-3 的区别：SR-3 前任有绑定状态行、仅 session.created 无信封，
    // 仍走降级 first 不变）。
    const lines = [
      { type: "run.state_change", to: "pending", from: null, reason: "seed", agentId: "researcher", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "session.created", backend: "process", backendSessionId: "proc_leg", agentId: "researcher", ts: "2026-08-18T00:00:00.100Z", seq: 2 },
      { type: "run.state_change", to: "completed", from: "pending", reason: "done", agentId: "researcher", ts: "2026-08-18T00:00:00.200Z", seq: 3 },
    ];
    writeFileSync(join(dir, "run_prior_leg.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

    const decision = await resolveReuseTurn({
      runDir: dir, runId: "run_new_leg", leadSession: "lead-LEG",
      workspace: "D:/proj", agentId: "researcher",
    });
    assert.equal(decision.kind, "busy",
      "全无信封前任 → 零绑定事件 → 状态不可归属 → 按在飞 busy（R14 时此处降级 first；TD-129b：本安装面 pre-envelope 前任 ≈0，实际影响≈0）");
  } finally { cleanupDir(dir); }
});

test("R15-LIN-P6: lineage 续接 busy 门 — 在飞 owner + 外 run 尾条 completed 不再翻成 resume；终态 owner + 伪 running 尾条不再误拒", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r15-p6-"));
  try {
    // (a) 篡改方向：在飞 owner + 外 run 伪 completed 尾条 → 必须保持 busy。
    await resolveLineageFirstTurn({
      runDir: dir, runId: "run_root_p6a", leadSession: "lead-P6a",
      workspace: "D:/proj", agentId: "coder_hq", rootRunId: "run_root_p6a",
    });
    const ta = new JsonlTranscript(join(dir, "run_root_p6a.jsonl"), { runId: "run_root_p6a", agentId: "coder_hq" });
    await ta.append("run.started", { backend: "claude-code" });
    await ta.transitionState(null, "pending", "created");
    await ta.append("session.created", { backend: "claude-code", backendSessionId: "abc" });
    await ta.transitionState("pending", "submitted", "spawned");
    // 修复前末条胜出 → 读成 terminal → 槽位被 child 收回 + resume：lineage
    // provider 会话在 owner 仍在飞时被并发驱动（Contract 6——探针 P6）。
    appendForeignLine(ta.filePath, {
      type: "run.state_change", runId: "run_evil", agentId: "coder_hq",
      to: "completed", from: "submitted", reason: "evil",
    });
    const contA = await resolveLineageContinuationTurn({
      runDir: dir, runId: "run_child_p6a", parentRunId: "run_root_p6a", rootRunId: "run_root_p6a",
      leadSession: "lead-P6a", workspace: "D:/proj", agentId: "coder_hq",
    });
    assert.equal(contA.kind, "busy",
      "绑定过滤后 owner 仍非终态 → busy（外 run completed 尾条不再把 lineage 续接门翻成 resume）");
    assert.equal(contA.activeRunId, "run_root_p6a");

    // (b) 反向：终态 owner + 外 run 伪 running 尾条 → 正常续接（不再被伪尾条阻断）。
    await resolveLineageFirstTurn({
      runDir: dir, runId: "run_root_p6r", leadSession: "lead-P6r",
      workspace: "D:/proj", agentId: "coder_hq", rootRunId: "run_root_p6r",
    });
    const tb = new JsonlTranscript(join(dir, "run_root_p6r.jsonl"), { runId: "run_root_p6r", agentId: "coder_hq" });
    await tb.append("run.started", { backend: "claude-code" });
    await tb.transitionState(null, "pending", "created");
    await tb.append("session.created", { backend: "claude-code", backendSessionId: "abc" });
    await tb.transitionState("pending", "completed", "done");
    appendForeignLine(tb.filePath, {
      type: "run.state_change", runId: "run_evil", agentId: "coder_hq",
      to: "running", from: "completed", reason: "evil",
    });
    const contB = await resolveLineageContinuationTurn({
      runDir: dir, runId: "run_child_p6r", parentRunId: "run_root_p6r", rootRunId: "run_root_p6r",
      leadSession: "lead-P6r", workspace: "D:/proj", agentId: "coder_hq",
    });
    assert.equal(contB.kind, "resume",
      "绑定过滤后 owner 终态 → 正常续接（伪 running 尾条不采信，不再误拒合法 continuation）");
    assert.equal(contB.routing.turn, "resume");
  } finally { cleanupDir(dir); }
});

test("R15-LIN-P6b: first 认领门 — 非终态 prior owner + 外 run 尾条 completed 不再翻成 first 认领（busy 保持）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r15-p6b-"));
  try {
    // 用另一个 runId 先占住 lineage 槽位（resolveLineageFirstTurn 的
    // prior-owner 路径：新鲜根正常不可能有前任，对立复用/对抗形状可达——
    // 函数文档注释明示该路径）。
    await resolveLineageFirstTurn({
      runDir: dir, runId: "run_squatter", leadSession: "lead-P6b",
      workspace: "D:/proj", agentId: "coder_hq", rootRunId: "run_root_p6b",
    });
    const t = new JsonlTranscript(join(dir, "run_squatter.jsonl"), { runId: "run_squatter", agentId: "coder_hq" });
    await t.append("run.started", { backend: "claude-code" });
    await t.transitionState(null, "pending", "created");
    await t.append("session.created", { backend: "claude-code", backendSessionId: "abc" });
    await t.transitionState("pending", "submitted", "spawned");
    // 外 run 伪 completed 尾条：修复前末条胜出 → 读成终态 → 槽位被 first
    // 认领，真实在飞的 squatter 与新 first 并发驱动同一 lineage 会话
    // （Contract 6——探针 P6b）。
    appendForeignLine(t.filePath, {
      type: "run.state_change", runId: "run_evil", agentId: "coder_hq",
      to: "completed", from: "submitted", reason: "evil",
    });

    const claim = await resolveLineageFirstTurn({
      runDir: dir, runId: "run_root_p6b", leadSession: "lead-P6b",
      workspace: "D:/proj", agentId: "coder_hq", rootRunId: "run_root_p6b",
    });
    assert.equal(claim.kind, "busy",
      "绑定过滤后 prior owner 仍非终态 → busy（外 run 尾条不再把 first 认领门翻成认领）");
    assert.equal(claim.activeRunId, "run_squatter");
  } finally { cleanupDir(dir); }
});

// =====================================================================
// R16 runCollect lane —— LIVE 修复探针（TD-127/TD-128 收口）
//
// 两处无绑定读取（原 :184 findLatest(session.created) / 原 :242
// findLatest(run.started)）是 append-only transcript 上的跨 run 注入面：
// 尾条外 run 伪造行直接赢得 serve 取回的目标地址（serveUrl/sessionId——
// 整体重定向面）或 directory 参数（cwd——目录重定向面）。本 lane 与
// correction/continuation/activity 不同：collectRunMessages 无上游身份门
// （extractCanonicalAgentId 只降级 agentId 为 "unknown"，不拒绝），伪造行
// 修复前真实可达两条重定向面——非分层一致性交换。
// 语义选择（二选一已明示）：:184 末条绑定（latest-session-wins，与 stop/
// activity 同序，全绑定输入上与修复前 findLatest 恒等）；:242 首条绑定
// （run.started 是派发时稳定事实——R12-C/R14-C 首条纪律；合法 transcript 至多
// 一条 run.started，首/末只在伪造尾条上分叉，首条=尾条伪造永不生效）。
// =====================================================================

test("R16-CO-1: 篡改探针 — 外 run 尾条 session.created 不再重定向 serve 取回（serveUrl/sessionId 整体重定向面）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r16-co1-"));
  let fetchCalls = 0;
  try {
    const runId = "run_co_1";
    // 本 run 合法事实：进程型会话（无 serveUrl）+ 一条证据事件。
    const lines = [
      { type: "run.submitted", runId, agentId: "researcher", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "session.created", backend: "process", backendSessionId: "proc_co1", runId, agentId: "researcher", ts: "2026-08-18T00:00:00.100Z", seq: 2 },
      { type: "run.started", backend: "claude-code", cwd: "D:/legal", runId, agentId: "researcher", ts: "2026-08-18T00:00:00.200Z", seq: 3 },
      { type: "run.event", kind: "command", command: "rg TODO", exitCode: 0, runId, agentId: "researcher", ts: "2026-08-18T00:00:00.300Z", seq: 4 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // 修复前 findLatest 采信尾条 → serve 路径 → fetch 打到伪造 serveUrl/sessionId。
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "session.created", runId: "run_evil", agentId: "researcher",
      backend: "opencode-serve", serveUrl: "http://127.0.0.1:6666", backendSessionId: "sess_evil",
    });

    const result = await collectRunMessages({
      runId, runDir: dir,
      fetchServeMessagesFn: async () => { fetchCalls += 1; return { data: [] }; },
      appendCollectedFn: async () => {},
    });
    assert.equal(fetchCalls, 0,
      "外 run 尾条 session.created 对绑定读取器不可见 → 本 run 进程路径，serve fetch 零调用（serveUrl/sessionId 重定向面关闭）");
    assert.equal(result.backend, "process", "本 run 自身绑定会话事实胜出（process）");
    assert.equal(result.reconstructed, true);
    assert.equal(result.data.length, 1, "本 run 证据事件照常重建");
  } finally { cleanupDir(dir); }
});

test("R16-CO-2: 篡改探针 — 外 run 尾条 run.started.cwd 不再重定向 serve directory 参数（首条绑定纪律）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r16-co2-"));
  let captured = null;
  try {
    const runId = "run_co_2";
    const lines = [
      { type: "run.submitted", runId, agentId: "researcher", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "session.created", backend: "opencode-serve", serveUrl: "http://127.0.0.1:4297", backendSessionId: "sess_co2", runId, agentId: "researcher", ts: "2026-08-18T00:00:00.100Z", seq: 2 },
      { type: "run.started", backend: "opencode-serve", cwd: "D:/legal", runId, agentId: "researcher", ts: "2026-08-18T00:00:00.200Z", seq: 3 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // 修复前 findLatest 取末条 run.started（无视信封）→ 伪造 D:/evil 赢得 directory。
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.started", runId: "run_evil", agentId: "researcher",
      backend: "opencode-serve", cwd: "D:/evil",
    });

    await collectRunMessages({
      runId, runDir: dir,
      fetchServeMessagesFn: async (serveUrl, sessionId, opts) => {
        captured = { serveUrl, sessionId, opts };
        return { data: [] };
      },
      appendCollectedFn: async () => {},
    });
    assert.equal(captured.opts.cwd, "D:/legal",
      "run.started 取首条 runId 绑定事实（派发时稳定事实）——外 run 尾条 cwd 不再重定向 directory 参数");
    assert.equal(captured.serveUrl, "http://127.0.0.1:4297", "serveUrl 仍来自本 run 绑定 session.created");
    assert.equal(captured.sessionId, "sess_co2", "sessionId 仍来自本 run 绑定 session.created");
  } finally { cleanupDir(dir); }
});

test("R16-CO-3: 序语义钉 — 多条【绑定】session.created 取末条（全绑定输入上与修复前 findLatest 恒等）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r16-co3-"));
  let captured = null;
  try {
    const runId = "run_co_3";
    const lines = [
      { type: "run.submitted", runId, agentId: "researcher", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "session.created", backend: "process", backendSessionId: "proc_first", runId, agentId: "researcher", ts: "2026-08-18T00:00:00.100Z", seq: 2 },
      { type: "session.created", backend: "opencode-serve", serveUrl: "http://127.0.0.1:4397", backendSessionId: "sess_last", runId, agentId: "researcher", ts: "2026-08-18T00:00:00.200Z", seq: 3 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

    await collectRunMessages({
      runId, runDir: dir,
      fetchServeMessagesFn: async (serveUrl, sessionId, opts) => {
        captured = { serveUrl, sessionId, opts };
        return { data: [] };
      },
      appendCollectedFn: async () => {},
    });
    assert.equal(captured.sessionId, "sess_last",
      "末条绑定 session.created 胜出（latest-session-wins——绑定交换保留既有末条序语义，与 stop/activity 同序；正常 transcript 每行绑定 → 行为不变）");
    assert.equal(captured.serveUrl, "http://127.0.0.1:4397");
  } finally { cleanupDir(dir); }
});

test("R16-CO-4: legacy 降级 — 无信封（pre-envelope）session.created 不可见 → 既有『无会话元数据』拒绝，零 fetch 零 append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r16-co4-"));
  let fetchCalls = 0;
  let appendCalls = 0;
  try {
    const runId = "run_co_4";
    // pre-envelope legacy 形状：全部行无 runId 字段（含 serve 形 session.created——
    // 修复前无绑定 findLatest 采信它并发起 serve fetch；R16 起不可见）。
    const lines = [
      { type: "run.submitted", agentId: "researcher", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "session.created", backend: "opencode-serve", serveUrl: "http://127.0.0.1:4297", backendSessionId: "sess_legacy", agentId: "researcher", ts: "2026-08-18T00:00:00.100Z", seq: 2 },
      { type: "run.started", backend: "opencode-serve", cwd: "D:/legacy", agentId: "researcher", ts: "2026-08-18T00:00:00.200Z", seq: 3 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

    await assert.rejects(
      () => collectRunMessages({
        runId, runDir: dir,
        fetchServeMessagesFn: async () => { fetchCalls += 1; return { data: [] }; },
        appendCollectedFn: async () => { appendCalls += 1; },
      }),
      /has no session metadata/,
      "旧格式 transcript 的取回降级为无会话元数据拒绝——Owner 2026-08-18 拍板不兼容（与 stop 面同错误、同处置）",
    );
    assert.equal(fetchCalls, 0, "不伪造参数发 serve fetch（fail-closed 于 fetch 之前）");
    assert.equal(appendCalls, 0, "零 append");
  } finally { cleanupDir(dir); }
});

test("R16-CO-5: legacy 降级 — 绑定 serve 会话 + 无信封 run.started → 既有 ?. 降级（cwd undefined，不伪造 directory）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r16-co5-"));
  let captured = null;
  try {
    const runId = "run_co_5";
    const lines = [
      { type: "run.submitted", runId, agentId: "researcher", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "session.created", backend: "opencode-serve", serveUrl: "http://127.0.0.1:4297", backendSessionId: "sess_co5", runId, agentId: "researcher", ts: "2026-08-18T00:00:00.100Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // run.started 行存在但无 runId 字段（pre-envelope）——绑定读取器不可见。
    // 修复前 findLatest 采信其 cwd；R16 起 ?. 链给出 undefined，后端省略
    // directory 参数（opencodeServe.js `if (cwd)`）→ serve 侧默认目录。
    appendFileSync(join(dir, `${runId}.jsonl`), `${JSON.stringify({
      type: "run.started", backend: "opencode-serve", cwd: "D:/legacy",
      agentId: "researcher", ts: "2026-08-18T00:00:00.200Z", seq: 3,
    })}\n`, "utf8");

    await collectRunMessages({
      runId, runDir: dir,
      fetchServeMessagesFn: async (serveUrl, sessionId, opts) => {
        captured = { serveUrl, sessionId, opts };
        return { data: [] };
      },
      appendCollectedFn: async () => {},
    });
    assert.equal(captured.sessionId, "sess_co5", "绑定会话事实照常取回（合法 serve 路径不受 legacy run.started 行影响）");
    assert.equal(captured.opts.cwd, undefined,
      "无可信 run.started → cwd undefined → directory 参数省略（serve 默认目录；绝不采用不可归属的 D:/legacy，也不伪造新值）");
  } finally { cleanupDir(dir); }
});

// =====================================================================
// R18 观测面卫生包（TD-128 P3 残存 + R16 会审新增登记；2026-08-18）
//
//   W1 报表污染类（绑定过滤，boundReportScope 单一定义处在 src/metrics.js）：
//       metrics.js aggregateRunMetrics 的 state/run.metrics/run.started 读取
//       与 duration 终点；commands/runs.js runs metrics/scorecard（另：两命令
//       的 runId join 前过 isValidRunId——锚点复核结论：两命令均不经
//       shared.js loadRun，直接 join+read，校验此前缺失）；commands/run.js
//       loadScorecardFromTranscript；src/smoke.js 两处 scorecard 读取。
//       legacy 选择（观测面=降级不设门）：全无信封 transcript 保持既有读法
//       （cli.test.js 的 pre-envelope 三态 JSON 契约钉住该行为）；任一事件带
//       信封（含伪造尾行）即严格绑定——外 run/无信封行不可见。
//   W2 状态投影类：runAwaitResult.js 初始读（:522）与等待循环每次 poll
//       （:673）的 findState 改绑定过滤（R15 范式 findState(events.filter(bound))）；
//       :269 手搓绑定反查换 findLatestBound SSOT（行为恒等）。legacy 选择：
//       全无信封 → findState([])="pending"——不可归属状态永不投影为终态
//       （与 R15"不可归属按在飞"同族），不 throw、不转 read_failure。
//   W3 自续接类：runManager.js resume 终态门（:1273）与 runStop.js
//       fromState（:162）同款绑定过滤。legacy 衔接：resume 全无信封 →
//       过终态门后由 R13-C 绑定 session 读取落入既有 null 拒绝（与修复前
//       在终态门拒绝同一外部结果——legacy resume 本就自 R13-C 起拒绝，
//       R13C-RESUME-5 钉）；runStop :162 的 legacy 形状不可达（session 门在
//       前，R13C-STOP-3 钉），故无 legacy 探针（WQ-02：唯一适用形状已由
//       既有探针覆盖）。
//   W4 明确不做（登记维持）：runCollect.js:85-91 事件重建 filter、
//       :109/:113 events[0]/seq 水位——TD-128 保持开放。
//
// 探针诚实口径（同本文件既有各节）：只验跨 run/无信封形状；同 runId 追加
// 伪造 = runs/ 写权限攻击面，读侧无解。R18-SM-1（smoke.js）例外：smoke.js
// module import 即执行 main()（真实 CLI/费用），无进程外注入 seam——源级
// 纪律钉（test/isolation-infra/stateChangeReasons.test.js:162 先例），变异
// 自证红。
// =====================================================================

// R18 CLI 探针公用：跑 src/cli.js（repo 根 cwd），返回 spawnSync 结果。
function runCli(args, runDir) {
  return spawnSync(process.execPath, ["src/cli.js", ...args, "--run-dir", runDir], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    timeout: 60000,
  });
}

// ----- W1a：runs metrics（metrics.js 聚合 + isValidRunId 接线） -----

test("R18-MET-1: 篡改探针 — 外 run 尾条不再污染 runs metrics 的 state/tokens/cost/duration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-met1-"));
  try {
    const runId = "run_r18_met";
    const lines = [
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-18T00:00:10.000Z", seq: 2 },
      { type: "run.metrics", runId, agentId: "coder_low", tokens: { input: 100, output: 50 }, costUsd: 0.02, ts: "2026-08-18T00:00:20.000Z", seq: 3 },
      { type: "run.completed", runId, agentId: "coder_low", ts: "2026-08-18T00:00:30.000Z", seq: 4 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // 外 run 伪造尾条：伪 failed 终态 + 伪 tokens/cost + 远期 ts（修复前分别
    // 赢得 findState 末条、findLatest 末条、events.at(-1) 的 duration 终点）。
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.state_change", runId: "run_evil", agentId: "coder_low",
      from: "completed", to: "failed", reason: "evil",
    });
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.metrics", runId: "run_evil", agentId: "coder_low",
      tokens: { input: 99999 }, costUsd: 99,
    });
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.completed", runId: "run_evil", agentId: "coder_low",
      ts: "2026-08-18T00:20:00.000Z",
    });

    const r = runCli(["runs", "metrics", runId, "--format", "json"], dir);
    assert.equal(r.status, 0, `CLI 成功（stderr: ${r.stderr}）`);
    const m = JSON.parse(r.stdout);
    assert.equal(m.state, "completed", "state 只由本 run 绑定事件计算（修复前读外 run 伪 failed）");
    assert.equal(m.tokens.input, 100, "tokens 取本 run 绑定 run.metrics（修复前读外 run 99999）");
    assert.equal(m.costUsd, 0.02, "cost 取本 run 绑定事实（修复前 99）");
    assert.equal(m.durationMs, 30000, "duration 终点取最后【绑定】事件 ts（修复前被外 run 远期 ts 拉到 20min）");
  } finally { cleanupDir(dir); }
});

test("R18-MET-2: 合法路径回归 — 全绑定 transcript 的 metrics 输出与篡改前完全一致", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-met2-"));
  try {
    const runId = "run_r18_met2";
    const lines = [
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-18T00:00:10.000Z", seq: 2 },
      { type: "run.metrics", runId, agentId: "coder_low", tokens: { input: 100, output: 50 }, costUsd: 0.02, ts: "2026-08-18T00:00:20.000Z", seq: 3 },
      { type: "run.completed", runId, agentId: "coder_low", ts: "2026-08-18T00:00:30.000Z", seq: 4 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const r = runCli(["runs", "metrics", runId, "--format", "json"], dir);
    assert.equal(r.status, 0);
    const m = JSON.parse(r.stdout);
    assert.equal(m.state, "completed");
    assert.equal(m.tokens.input, 100);
    assert.equal(m.costUsd, 0.02);
    assert.equal(m.durationMs, 30000, "合法全绑定输入 → 绑定过滤器恒等 → 输出零变化");
  } finally { cleanupDir(dir); }
});

// ----- W1b：runs scorecard（scorecard.checked/run.started 绑定 + isValidRunId） -----

test("R18-SC-1: 篡改探针 — 本 run 无 scorecard.checked 时，外 run 尾条不再伪造 scorecard 报告", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-sc1-"));
  try {
    const runId = "run_r18_sc1";
    const lines = [
      { type: "run.started", runId, agentId: "coder_low", scorecardConfigured: false, ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-18T00:00:01.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // 修复前 events.find 采信外 run 尾条 → 报告出一份本 run 不存在的 passed scorecard。
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "scorecard.checked", runId: "run_evil", agentId: "coder_low",
      passed: true, checks: [{ name: "forge", passed: true, evidence: "forged" }],
    });

    const r = runCli(["runs", "scorecard", runId, "--format", "json"], dir);
    assert.equal(r.status, 0, `CLI 成功（stderr: ${r.stderr}）`);
    assert.deepEqual(JSON.parse(r.stdout), { runId, scorecard: null, reason: "no_rules" },
      "外 run 尾条对绑定读取器不可见 → 如实报告无 scorecard（reason 由本 run 绑定 run.started 推断）");
  } finally { cleanupDir(dir); }
});

test("R18-SC-2: 篡改探针 — reason 推断的外 run 伪 run.started 不再把 no_rules 翻成 failed_before_scorecard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-sc2-"));
  try {
    const runId = "run_r18_sc2";
    // 本 run 无自身 run.started（污染形状：外 run 尾条供给该事实）。
    const lines = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.started", runId: "run_evil", agentId: "coder_low", scorecardConfigured: true,
    });

    const r = runCli(["runs", "scorecard", runId, "--format", "json"], dir);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).reason, "no_rules",
      "reason 推断只读本 run 绑定 run.started（修复前外 run 尾条 → failed_before_scorecard）");
  } finally { cleanupDir(dir); }
});

test("R18-SC-3: 合法路径回归 — 本 run 绑定 scorecard.checked 照常报告（首条纪律，外 run 尾条不夺值）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-sc3-"));
  try {
    const runId = "run_r18_sc3";
    const lines = [
      { type: "run.started", runId, agentId: "coder_low", scorecardConfigured: true, ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "scorecard.checked", runId, agentId: "coder_low", passed: false, checks: [{ name: "commandsPassed", passed: false, evidence: "no command evidence" }], ts: "2026-08-18T00:00:02.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "scorecard.checked", runId: "run_evil", agentId: "coder_low",
      passed: true, checks: [],
    });

    const r = runCli(["runs", "scorecard", runId, "--format", "json"], dir);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.passed, false, "本 run 自身绑定 scorecard 事实胜出（合法路径输出不变）");
    assert.equal(parsed.checks[0].name, "commandsPassed");
  } finally { cleanupDir(dir); }
});

// ----- W1c：runs metrics / runs scorecard 的 isValidRunId join 前校验 -----

test("R18-LR-2: runs metrics/scorecard 的 runId join 前过 isValidRunId（loadRun 同款 fixed-safe 拒绝）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-lr2-"));
  try {
    const legalId = "run_r18_legal_ok-1";
    writeFileSync(join(dir, `${legalId}.jsonl`), `${JSON.stringify({
      type: "run.started", runId: legalId, agentId: "coder_low",
      scorecardConfigured: false, ts: "2026-08-18T00:00:00.000Z", seq: 1,
    })}\n`, "utf8");

    // (a) 穿越与注入形状全部在 join 前拒绝（两命令同一 SSOT、同一文案）。
    const malicious = ["../evil", "a/b", "a\\b", "C:\\evil\\x", "/abs/x", ".hidden", "-flag", "has space", "run;rm", "run&x"];
    for (const sub of ["metrics", "scorecard"]) {
      for (const bad of malicious) {
        const r = runCli(["runs", sub, bad, "--format", "json"], dir);
        assert.notEqual(r.status, 0, `runs ${sub} 拒绝形状 ${JSON.stringify(bad)}`);
        assert.match(r.stderr, /runId is malformed/, `runs ${sub} fixed-safe 文案`);
        assert.equal(r.stderr.includes(bad), false, "文案不得回显被拒输入");
      }
    }

    // (b) 合法 id 两命令照常（读回落盘事实，不因校验误伤）。
    const met = runCli(["runs", "metrics", legalId, "--format", "json"], dir);
    assert.equal(met.status, 0);
    assert.equal(JSON.parse(met.stdout).runId, legalId);
    const sc = runCli(["runs", "scorecard", legalId, "--format", "json"], dir);
    assert.equal(sc.status, 0);
    assert.equal(JSON.parse(sc.stdout).reason, "no_rules");

    // (c) SSOT 现状钉（与 R14-LR-1(c) 同口径）：isValidRunId 无长度上限——超长
    // 字符集合法 id 通过校验、止步于文件不存在（ENOENT），不误报 malformed。
    const overlong = "x".repeat(200);
    const r = runCli(["runs", "metrics", overlong], dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ENOENT/, "超长字符集合法 id 止步于文件不存在");
    assert.doesNotMatch(r.stderr, /runId is malformed/);
  } finally { cleanupDir(dir); }
});

// ----- W1d：commands/run.js loadScorecardFromTranscript（R18 起导出为探针位） -----

test("R18-RUN-1: 篡改探针 + 合法回归 — run 汇总的 scorecard 段只取本 run 绑定事实", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-run1-"));
  try {
    const runId = "run_r18_run";
    const write = (events) =>
      writeFileSync(join(dir, `${runId}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
    const ownChecked = {
      type: "scorecard.checked", runId, agentId: "coder_low", passed: false,
      checks: [{ name: "commandsPassed", passed: false, evidence: "none" }],
      ts: "2026-08-18T00:00:02.000Z", seq: 2,
    };
    const ownStarted = {
      type: "run.started", runId, agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1,
    };
    const foreignChecked = {
      type: "scorecard.checked", runId: "run_evil", agentId: "coder_low",
      passed: true, checks: [], ts: "2026-08-18T00:00:09.000Z", seq: 99,
    };

    // (a) 合法回归：本 run 绑定 scorecard.checked 照常投影。
    write([ownStarted, ownChecked]);
    const legal = await loadScorecardFromTranscript(join(dir, `${runId}.jsonl`), runId);
    assert.deepEqual(legal, { passed: false, checks: ownChecked.checks }, "合法绑定事实照常");

    // (b) 篡改：本 run 无自身 scorecard.checked + 外 run 尾条 → null（修复前
    // events.find 采信外 run 尾条 → run 汇总带出伪造 scorecard 段）。
    write([ownStarted]);
    appendForeignLine(join(dir, `${runId}.jsonl`), foreignChecked);
    const tampered = await loadScorecardFromTranscript(join(dir, `${runId}.jsonl`), runId);
    assert.equal(tampered, null, "外 run 尾条不供给 run 汇总的 scorecard 段");

    // (c) 序语义：本 run 有自身事实时外 run 尾条不夺值（首条纪律）。
    write([ownStarted, ownChecked]);
    appendForeignLine(join(dir, `${runId}.jsonl`), foreignChecked);
    const both = await loadScorecardFromTranscript(join(dir, `${runId}.jsonl`), runId);
    assert.equal(both.passed, false, "本 run 首条绑定事实胜出");
  } finally { cleanupDir(dir); }
});

// ----- W1e：src/smoke.js（源级纪律钉——module import 即执行 main()，无注入 seam） -----

test("R18-SM-1: 源级纪律钉 — smoke.js 两处 scorecard 读取经 boundReportScope + findFirstBound（legacy 分支仅为声明回退）", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../../src/smoke.js"), "utf8");
  const scoped = src.match(/boundReportScope\(events, run\.runId\)/g) ?? [];
  assert.equal(scoped.length, 2, "smokeScorecard 场景 1/2 各经一次 boundReportScope 收窄");
  // 钉完整三元形状：绑定分支在前（findFirstBound 首条纪律），裸 events.find
  // 只允许作为 boundReportScope 返回 null（全无信封 legacy transcript）时的
  // 声明回退分支存在。变异回裸 find（无收窄）→ 零匹配 → 红
  // （stateChangeReasons.test.js:162 同款源级守卫先例）。
  const ternary = src.match(
    /\? findFirstBound\(scope, "scorecard\.checked", run\.runId\)\s*\r?\n\s*: events\.find\(\(e\) => e\.type === "scorecard\.checked"\);/g,
  ) ?? [];
  assert.equal(ternary.length, 2, "scorecard.checked 读取 = 绑定分支优先 + legacy 声明回退（两处场景同形）");
});

// ----- W2：runAwaitResult（初始读 + 每次 poll 的 findState 绑定；:269 SSOT 交换） -----

test("R18-AW-1: 篡改探针 — 外 run 伪 terminal 尾条不再把 await 点读翻成终态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-aw1-"));
  try {
    const runId = "run_r18_aw1";
    const lines = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-18T00:00:01.000Z", seq: 2 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event", ts: "2026-08-18T00:00:03.000Z", seq: 3 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // 修复前 findState 末条胜出 → 读到外 run 伪 completed → terminal 提前成立、
    // compact collect 在伪终态上执行。
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.state_change", runId: "run_evil", agentId: "coder_low",
      from: "running", to: "completed", reason: "evil",
    });

    const out = await runAwaitResult({ runId, runDir: dir, waitMs: 0 });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.state, "running", "状态只由本 run 绑定事件计算（修复前 completed）");
    assert.equal(out.terminal, false, "外 run 伪 terminal 尾条不再翻成终态");
    assert.equal(out.result.status, "not_terminal", "不触发伪终态上的 compact collect");
  } finally { cleanupDir(dir); }
});

test("R18-AW-2: 篡改探针 — 等待循环内 poll 快照的外 run 伪 terminal 尾条不再提前返回 terminal-during-wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-aw2-"));
  try {
    const runId = "run_r18_aw2";
    const cleanRunning = [
      { type: "run.submitted", runId, agentId: "coder_low", seq: 1 },
      { type: "run.started", runId, agentId: "coder_low", seq: 2 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event", seq: 3 },
    ];
    const tailed = [...cleanRunning, {
      type: "run.state_change", runId: "run_evil", agentId: "coder_low",
      from: "running", to: "completed", reason: "evil", seq: 99,
    }];
    let readCalls = 0;
    let t = 1000000;
    const out = await runAwaitResult({
      runId, runDir: dir, waitMs: 4000,
      nowFn: () => t,
      pollIntervalMs: 2000,
      sleepFn: async (ms) => { t += ms; },
      readTranscriptFn: async () => { readCalls += 1; return readCalls === 1 ? cleanRunning : tailed; },
    });
    assert.ok(readCalls >= 2, "至少一次 poll 读到带伪尾条的快照");
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.terminal, false, "poll 状态投影绑定后伪 terminal 尾条不生效——窗口如实耗尽（修复前 terminal-during-wait 提前返回）");
    assert.equal(out.state, "running");
    assert.equal(out.result.status, "not_terminal");
  } finally { cleanupDir(dir); }
});

test("R18-AW-3: 合法路径回归 — 终态 transcript 的 await 点读照常观察 + compact 收集", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-aw3-"));
  try {
    const runId = "run_r18_aw3";
    const lines = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-07-28T00:00:00.000Z", seq: 1 },
      { type: "session.created", backend: "process", backendSessionId: "proc_aw3", runId, agentId: "coder_low", seq: 2 },
      { type: "run.started", backend: "claude-code", runId, agentId: "coder_low", ts: "2026-07-28T00:00:01.000Z", seq: 3 },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "FINAL" }], runId, agentId: "coder_low", ts: "2026-07-28T00:00:10.000Z", seq: 4 },
      { type: "run.completed", runId, agentId: "coder_low", ts: "2026-07-28T00:10:00.000Z", seq: 5 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-07-28T00:10:01.000Z", seq: 6 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const out = await runAwaitResult({ runId, runDir: dir, waitMs: 0 });
    assert.equal(out.terminal, true, "全绑定合法终态照常观察（过滤器恒等）");
    assert.equal(out.state, "completed");
    assert.equal(out.result.status, "available");
    assert.deepEqual(out.result.messages, [{ role: "assistant", text: "FINAL", truncated: false }]);
  } finally { cleanupDir(dir); }
});

test("R18-AW-4: legacy 语义钉 — 全无信封 transcript 的 await 状态投影降级 pending（不可归属永不投影终态；不 throw 不 read_failure）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-aw4-"));
  try {
    const runId = "run_r18_aw4";
    // pre-envelope legacy 形状：全部行无 runId 字段，末事件 run.completed。
    // 修复前 findState 兜底推断 completed → terminal；R18 绑定过滤后零绑定
    // 事件 → findState([])="pending"——状态不可归属时永不投影为终态（观测面
    // 降级不设门：不 throw、不转 read_failure，等待窗如实耗尽）。TD-129b：
    // 本安装面 pre-envelope transcript ≈0，实际影响≈0。
    const lines = [
      { type: "run.submitted", agentId: "coder_low", ts: "2026-07-28T00:00:00.000Z", seq: 1 },
      { type: "run.started", backend: "claude-code", agentId: "coder_low", ts: "2026-07-28T00:00:01.000Z", seq: 2 },
      { type: "run.completed", agentId: "coder_low", ts: "2026-07-28T00:10:00.000Z", seq: 3 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const out = await runAwaitResult({ runId, runDir: dir, waitMs: 0 });
    assert.equal(out.observationOutcome, "observed", "不是 read_failure——降级不设门");
    assert.equal(out.state, "pending", "状态不可归属 → pending（修复前 legacy 推断 completed）");
    assert.equal(out.terminal, false);
    assert.equal(out.result.status, "not_terminal");
  } finally { cleanupDir(dir); }
});

test("R18-AW-5: SSOT 序语义钉 — compact 的 session 反查取末条【绑定】session.created（findLatestBound 交换行为恒等，设计上不红）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-aw5-"));
  try {
    const runId = "run_r18_aw5";
    const lines = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-07-28T00:00:00.000Z", seq: 1 },
      { type: "session.created", backend: "process", backendSessionId: "proc_first", runId, agentId: "coder_low", seq: 2 },
      { type: "run.started", backend: "claude-code", runId, agentId: "coder_low", ts: "2026-07-28T00:00:01.000Z", seq: 3 },
      { type: "session.created", backend: "opencode-serve", backendSessionId: "sess_last", runId, agentId: "coder_low", seq: 4 },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }], runId, agentId: "coder_low", ts: "2026-07-28T00:00:10.000Z", seq: 5 },
      { type: "run.completed", runId, agentId: "coder_low", ts: "2026-07-28T00:10:00.000Z", seq: 6 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-07-28T00:10:01.000Z", seq: 7 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "session.created", runId: "run_evil", agentId: "coder_low",
      backend: "opencode-serve", serveUrl: "http://127.0.0.1:6666", backendSessionId: "sess_evil",
    });

    const out = await runAwaitResult({ runId, runDir: dir, waitMs: 0 });
    assert.equal(out.terminal, true);
    // 手搓反查（R18 前）与 findLatestBound（R18 后）同为「末条 runId 绑定」——
    // 本探针钉交换后的语义原样：多条绑定取末条，外 run 尾条不可见。行为恒等
    // 交换（纪律一致性），设计上不红（R14-CR-1 / R16-CO-3 同口径）。
    assert.equal(out.result.backend, "opencode-serve", "末条绑定 session.created 的 backend 胜出");
    assert.notEqual(out.result.backend, undefined);
  } finally { cleanupDir(dir); }
});

// ----- W3：runManager resume 终态门（makeReplayBackend/makeManager 同 resumeBoundRead.test.js） -----

function makeReplayBackend() {
  const prompts = [];
  const backend = {
    async spawn(agent, task) {
      prompts.push(task.prompt);
      return {
        backend: "process",
        backendSessionId: `proc_mock_${prompts.length}`,
        async *events() {
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
  return { backend, prompts };
}

function makeManager(dir, backend) {
  const config = {
    registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 2000,
    timeout: 5000, retries: 0, defaultIsolation: "none",
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      return { id, backend: "claude-code", cwd: dir, ...defined };
    },
    listAgents() { return []; },
  });
  return new RunManager({ config, readRegistry, backendFor: () => backend });
}

test("R18-RES-1: 篡改探针 — 外 run 伪 running 尾条不再把 terminal run 的 resume 拒绝翻成接续", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-res1-"));
  try {
    const runId = "run_r18_res1";
    const { backend, prompts } = makeReplayBackend();
    const manager = makeManager(dir, backend);
    await manager.start("proc_agent", { prompt: "original prompt", runId });
    assert.equal(prompts.length, 1, "start spawn 一次");
    // 驱动到终态：本 run 绑定 terminal state_change（first-terminal-wins 之外
    // 的读取面只有 resume 终态门——此处手写终态行避免动 active run）。
    const t = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "test-agent" });
    await t.transitionState("submitted", "completed", "done");
    // 外 run 伪 running 尾条：修复前 findState 末条胜出 → 非终态 → 过终态门 →
    // 绑定 session/run.started 都在 → RESUME（终态 run 被接续，TD-128 W3 注册危害）。
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.state_change", runId: "run_evil", agentId: "test-agent",
      from: "completed", to: "running", reason: "evil",
    });

    const resumed = await manager.resume(runId);
    assert.equal(resumed, null, "绑定过滤后本 run 自身终态生效 → null（修复前接续终态 run）");
    assert.equal(prompts.length, 1, "零 respawn——终态 run 不再被伪 running 尾条翻成可续接");
  } finally { cleanupDir(dir); }
});

test("R18-RES-2: 反向篡改 + 合法回归 — 在飞 run 的 resume 不再被外 run 伪 terminal 尾条误拒；无尾条照常续接", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-res2-"));
  try {
    // (a) 反向篡改：在飞 run + 外 run 伪 completed 尾条。修复前 findState 读到
    // 伪终态 → null（合法续接被阻断——自续接 DoS 面）；绑定后照常 resume。
    const runIdA = "run_r18_res2a";
    const managerA = makeManager(dir, makeReplayBackend().backend);
    await managerA.start("proc_agent", { prompt: "original prompt", runId: runIdA });
    appendForeignLine(join(dir, `${runIdA}.jsonl`), {
      type: "run.state_change", runId: "run_evil", agentId: "test-agent",
      from: "running", to: "completed", reason: "evil",
    });
    const resumedA = await managerA.resume(runIdA);
    assert.ok(resumedA, "在飞 run 照常 resume（伪 terminal 尾条不采信，修复前 null）");

    // (b) 合法回归：无尾条的在飞 run resume → 重放原 prompt。
    const runIdB = "run_r18_res2b";
    const { backend, prompts } = makeReplayBackend();
    const managerB = makeManager(dir, backend);
    await managerB.start("proc_agent", { prompt: "original prompt", runId: runIdB });
    const resumedB = await managerB.resume(runIdB);
    assert.ok(resumedB, "无尾条 → resume 返回 Run（合法路径零变化）");
    assert.equal(prompts[1], "original prompt", "重放本 run 绑定原 prompt");
  } finally { cleanupDir(dir); }
});

// ----- W3：runStop fromState（审计 from 字段绑定） -----

test("R18-STOP-1: 篡改探针 + 合法回归 — stop 落盘的 state_change.from 只由本 run 绑定状态供给", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r18-stop1-"));
  try {
    const seed = async (runId, withTail) => {
      const t = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "test-agent" });
      await t.append("run.started", { backend: "claude-code" });
      await t.append("session.created", { backend: "process", backendSessionId: "proc_7777" });
      await t.transitionState(null, "pending", "created");
      await t.transitionState("pending", "submitted", "spawned");
      if (withTail) {
        // 外 run 非终态伪尾条（非终态：不触发 transitionState 的
        // _detectExistingTerminal 拒绝，隔离出 fromState 读取面）。修复前
        // findState 末条胜出 → fromState 读到外 run 的 "running"。
        appendForeignLine(t.filePath, {
          type: "run.state_change", runId: "run_evil", agentId: "test-agent",
          from: "submitted", to: "running", reason: "evil",
        });
      }
      return t.filePath;
    };
    const stopWithDeps = async (runId) => {
      let alive = true;
      const result = await stopRun({
        runId, runDir: dir,
        deps: {
          kill: () => { alive = false; return { called: true, exitCode: 0 }; },
          isAlive: () => alive,
          alert: async () => {},
        },
      });
      return result;
    };

    // (a) 合法回归：无尾条 → from === 本 run 自身 "submitted"。
    await seed("run_r18_stop_legal", false);
    const legal = await stopWithDeps("run_r18_stop_legal");
    assert.equal(legal.terminalAccepted, true);
    const legalEvents = await readTranscript(join(dir, "run_r18_stop_legal.jsonl"));
    assert.equal(legalEvents.find((e) => e.type === "run.state_change" && e.to === "aborted").from, "submitted",
      "合法路径 from 字段照常来自本 run 状态");

    // (b) 篡改：外 run 伪尾条不再供给 from（审计事实绑定）。
    await seed("run_r18_stop_tail", true);
    const tampered = await stopWithDeps("run_r18_stop_tail");
    assert.equal(tampered.terminalAccepted, true, "winner claim 不受尾条影响");
    const tamperedEvents = await readTranscript(join(dir, "run_r18_stop_tail.jsonl"));
    assert.equal(tamperedEvents.find((e) => e.type === "run.state_change" && e.to === "aborted").from, "submitted",
      "from 只由本 run 绑定状态计算（修复前外 run 尾条供给 \"running\"）");
  } finally { cleanupDir(dir); }
});

// =====================================================================
// R19 廉价尾巴清扫（TD-128 会审补登三面 + --summary 登记面；2026-08-18）
//
//   W1 runWait.js —— 初始读（原 :280）与等待循环每次 poll（原 :373）的
//       findState 改绑定过滤（R15 范式 `findState(events.filter(bound))`，
//       与 runAwaitResult R18 W2 同款）。legacy 选择（观测面=降级不设门，
//       对齐 runAwaitResult）：全无信封 transcript → findState([])="pending"
//       ——不可归属状态永不投影为终态，不 throw、不转 read_failure，等待窗
//       如实耗尽。cursor/agentId 维持各自既有 SSOT（不在本轮锚点）。
//   W2 runs metrics --summary —— 调用方逐文件读取，【文件名 stem 即权威
//       runId】：aggregateSummary 增可选 runIds 形参逐文件转发绑定读者
//       （boundReportScope 单一定义处复用，R18 导出）；metrics.js 注释
//       "无权威 runId"措辞一并修正（会审指出不实）。legacy 全无信封文件
//       经 boundReportScope 自身规则保持历史读法（--summary 是最可能扫到
//       legacy 文件的聚合面，钉住该降级）。
//   W3 smoke.js:274 —— 场景 2 PASS/FAIL 判定的末条 state_change 绑定到本
//       smoke runId。测试选择（明示）：smoke.js module 顶层即执行 main()
//       （真实 CLI/费用），无进程外注入 seam——源级纪律钉（R18-SM-1 /
//       stateChangeReasons.test.js:162 先例），变异自证红。
//
// 探针诚实口径（同本文件既有各节）：只验跨 run/无信封形状；同 runId 追加
// 伪造 = runs/ 写权限攻击面，读侧无解。保持开放（登记维持，不在本钉范围）：
// smoke.js:87-88 smokeOne 的 state_chain/run.started worktreePath 读取。
// =====================================================================

// ----- W1：runWait（初始读 + 等待循环 poll 的 findState 绑定） -----

// runWait 注入形状：fake clock + 即时 sleep（waitMs 下界 180000——窗口耗尽零真实等待）。
// readTranscriptFn 不含在内：WT-1/WT-2 注入快照，WT-3/WT-4 走真实文件读取。
function fakeWaitClock() {
  let t = 1000000;
  return {
    nowFn: () => t,
    pollIntervalMs: 60000,
    sleepFn: async (ms) => { t += ms; },
  };
}

test("R19-WT-1: 篡改探针 — 初始读快照内的外 run 伪 terminal 尾条不再把 run_wait 翻成终态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r19-wt1-"));
  try {
    const runId = "run_r19_wt1";
    const tailed = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-18T00:00:01.000Z", seq: 2 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event", ts: "2026-08-18T00:00:03.000Z", seq: 3 },
      // 外 run 伪 terminal 尾条：修复前 findState 末条胜出 → 初始读即读成
      // completed → terminal 提前返回（waitedMs 0 的伪终态观察）。
      { type: "run.state_change", runId: "run_evil", agentId: "coder_low", from: "running", to: "completed", reason: "evil", ts: "2026-08-18T00:00:04.000Z", seq: 99 },
    ];
    const out = await runWait({
      runId, runDir: dir, waitMs: 180000,
      ...fakeWaitClock(),
      readTranscriptFn: async () => tailed,
    });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.state, "running", "状态只由本 run 绑定事件计算（修复前初始读即读成外 run 伪 completed）");
    assert.equal(out.terminal, false, "外 run 伪 terminal 尾条不再把初始读翻成终态");
    assert.equal(out.returnedEarly, false, "等待窗如实耗尽（修复前伪终态提前返回）");
  } finally { cleanupDir(dir); }
});

test("R19-WT-2: 篡改探针 — 等待循环内 poll 快照的外 run 伪 terminal 尾条不再提前返回 terminal-during-wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r19-wt2-"));
  try {
    const runId = "run_r19_wt2";
    const cleanRunning = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-18T00:00:01.000Z", seq: 2 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event", ts: "2026-08-18T00:00:03.000Z", seq: 3 },
    ];
    const tailed = [...cleanRunning, {
      type: "run.state_change", runId: "run_evil", agentId: "coder_low",
      from: "running", to: "completed", reason: "evil", ts: "2026-08-18T00:00:04.000Z", seq: 99,
    }];
    let readCalls = 0;
    const out = await runWait({
      runId, runDir: dir, waitMs: 180000,
      ...fakeWaitClock(),
      readTranscriptFn: async () => { readCalls += 1; return readCalls === 1 ? cleanRunning : tailed; },
    });
    assert.ok(readCalls >= 2, "至少一次 poll 读到带伪尾条的快照");
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.terminal, false, "poll 状态投影绑定后伪 terminal 尾条不生效——窗口如实耗尽（修复前 terminal-during-wait 提前返回）");
    assert.equal(out.state, "running");
    assert.equal(out.returnedEarly, false);
  } finally { cleanupDir(dir); }
});

test("R19-WT-3: 合法路径回归 — 全绑定终态 transcript 的 run_wait 照常立即观察终态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r19-wt3-"));
  try {
    const runId = "run_r19_wt3";
    const lines = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-18T00:00:01.000Z", seq: 2 },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }], runId, agentId: "coder_low", ts: "2026-08-18T00:00:10.000Z", seq: 3 },
      { type: "run.completed", runId, agentId: "coder_low", ts: "2026-08-18T00:10:00.000Z", seq: 4 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-18T00:10:01.000Z", seq: 5 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // 真实文件读取 + fake clock（即便回归失败也不真实等待 180s，快速暴露）。
    const out = await runWait({ runId, runDir: dir, waitMs: 180000, ...fakeWaitClock() });
    assert.equal(out.terminal, true, "全绑定合法终态照常立即观察（过滤器恒等）");
    assert.equal(out.state, "completed");
    assert.equal(out.returnedEarly, true);
    assert.equal(out.liveness, "terminal");
    assert.equal(out.agentId, "coder_low", "信封 agentId 照常提取");
  } finally { cleanupDir(dir); }
});

test("R19-WT-4: legacy 语义钉 — 全无信封 transcript 的 run_wait 状态投影降级 pending（不可归属永不投影终态；不 throw 不 read_failure）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r19-wt4-"));
  try {
    const runId = "run_r19_wt4";
    // pre-envelope legacy 形状：全部行无 runId 字段，末事件 run.completed。
    // 修复前 findState 兜底推断 completed → terminal；R19 绑定过滤后零绑定
    // 事件 → findState([])="pending"——状态不可归属时永不投影为终态（观测面
    // 降级不设门：不 throw、不转 read_failure，等待窗如实耗尽）。TD-129b：
    // 本安装面 pre-envelope transcript ≈0，实际影响≈0。
    const lines = [
      { type: "run.submitted", agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "run.started", backend: "claude-code", agentId: "coder_low", ts: "2026-08-18T00:00:01.000Z", seq: 2 },
      { type: "run.completed", agentId: "coder_low", ts: "2026-08-18T00:10:00.000Z", seq: 3 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const out = await runWait({ runId, runDir: dir, waitMs: 180000, ...fakeWaitClock() });
    assert.equal(out.observationOutcome, "observed", "不是 read_failure——降级不设门");
    assert.equal(out.state, "pending", "状态不可归属 → pending（修复前 legacy 推断 completed）");
    assert.equal(out.terminal, false);
    assert.equal(out.returnedEarly, false, "等待窗如实耗尽");
  } finally { cleanupDir(dir); }
});

// ----- W2：runs metrics --summary（调用方逐文件 stem 绑定） -----

test("R19-SUM-1: 篡改探针 — 单文件内外 run 尾条不再污染 --summary 聚合", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r19-sum1-"));
  try {
    const runId = "run_r19_sum1";
    const lines = [
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-18T00:00:10.000Z", seq: 2 },
      { type: "run.metrics", runId, agentId: "coder_low", tokens: { input: 100, output: 50 }, costUsd: 0.02, ts: "2026-08-18T00:00:20.000Z", seq: 3 },
      { type: "run.completed", runId, agentId: "coder_low", ts: "2026-08-18T00:00:30.000Z", seq: 4 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // 外 run 伪造尾条三连（R18-MET-1 同形状）：伪 failed 终态 + 伪 tokens +
    // 远期 ts——修复前分别赢得逐文件聚合的 findState 末条 / findLatest 末条 /
    // duration 终点。
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.state_change", runId: "run_evil", agentId: "coder_low",
      from: "completed", to: "failed", reason: "evil",
    });
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.metrics", runId: "run_evil", agentId: "coder_low",
      tokens: { input: 99999 }, costUsd: 99,
    });
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.completed", runId: "run_evil", agentId: "coder_low",
      ts: "2026-08-18T00:20:00.000Z",
    });

    const r = runCli(["runs", "metrics", "--summary", "--format", "json"], dir);
    assert.equal(r.status, 0, `CLI 成功（stderr: ${r.stderr}）`);
    const s = JSON.parse(r.stdout);
    assert.equal(s.totalRuns, 1);
    assert.deepEqual(s.byState, { completed: 1 }, "byState 只由本 run 绑定事件计算（修复前读外 run 伪 failed）");
    assert.equal(s.successRate, 1, "successRate 不再被伪 failed 拉低");
    assert.deepEqual(s.totalTokens, { input: 100, output: 50 }, "tokens 取本 run 绑定 run.metrics（修复前读外 run 99999）");
    assert.equal(s.avgDurationMs, 30000, "duration 终点取最后【绑定】事件 ts（修复前被外 run 远期 ts 拉到 20min）");
  } finally { cleanupDir(dir); }
});

test("R19-SUM-2: 合法 + legacy 回归 — 全绑定文件照常聚合；全无信封 legacy 文件保持历史读法照常计入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r19-sum2-"));
  try {
    // (a) 全绑定文件：completed + metrics，duration 30000。
    const boundId = "run_r19_sum2a";
    const boundLines = [
      { type: "run.started", runId: boundId, agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId: boundId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-18T00:00:10.000Z", seq: 2 },
      { type: "run.metrics", runId: boundId, agentId: "coder_low", tokens: { input: 100, output: 50 }, costUsd: 0.02, ts: "2026-08-18T00:00:20.000Z", seq: 3 },
      { type: "run.completed", runId: boundId, agentId: "coder_low", ts: "2026-08-18T00:00:30.000Z", seq: 4 },
    ];
    writeFileSync(join(dir, `${boundId}.jsonl`), `${boundLines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // (b) pre-envelope legacy 文件：全部行无 runId（boundReportScope 无法绑定 →
    // 历史无绑定读法照常计入聚合——usage.md 声明的 legacy 降级，--summary 是
    // 最可能扫到 legacy 文件的聚合面）。findState 兜底 run.completed →
    // completed；duration = started.ts → 末事件 ts = 10000；无 metrics。
    const legacyId = "run_r19_sum2b";
    const legacyLines = [
      { type: "run.started", backend: "claude-code", agentId: "coder_low", ts: "2026-08-18T00:00:00.000Z", seq: 1 },
      { type: "run.completed", agentId: "coder_low", ts: "2026-08-18T00:00:10.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${legacyId}.jsonl`), `${legacyLines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

    const r = runCli(["runs", "metrics", "--summary", "--format", "json"], dir);
    assert.equal(r.status, 0, `CLI 成功（stderr: ${r.stderr}）`);
    const s = JSON.parse(r.stdout);
    assert.equal(s.totalRuns, 2);
    assert.deepEqual(s.byState, { completed: 2 }, "全绑定文件照常聚合；legacy 无信封文件保持历史读法照常计入");
    assert.deepEqual(s.totalTokens, { input: 100, output: 50 }, "tokens 只来自有绑定 metrics 的文件");
    assert.equal(s.avgDurationMs, 20000, "(30000 + 10000) / 2——两文件各自照常（绑定对全绑定输入恒等、对 legacy 输入降级不设门）");
  } finally { cleanupDir(dir); }
});

// ----- W3：smoke.js:274（源级纪律钉——module 顶层即执行 main()，无注入 seam） -----

test("R19-SM-2: 源级纪律钉 — smoke 场景 2 PASS/FAIL 判定的末条 state_change 读取经 runId 绑定过滤", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../../src/smoke.js"), "utf8");
  // 钉绑定过滤形状：lastChange = runId 绑定过滤后的末条 state_change。变异回
  // 裸 filter（无收窄）→ 零匹配 → 红（R18-SM-1 / stateChangeReasons.test.js:162
  // 同款源级守卫先例——smoke.js 无进程外注入 seam，源级纪律钉是唯一可测面）。
  const bound = src.match(
    /events\.filter\(\(e\) => e\.type === "run\.state_change" && e\.runId === run\.runId\)\.at\(-1\)/g,
  ) ?? [];
  assert.equal(bound.length, 1, "场景 2 判定的 lastChange 只取本 smoke run 信封的末条 state_change");
  // 反向钉：无绑定 .at(-1) 直取末条的裸形状必须消失（smokeOne :87 的
  // stateChanges 映射用 .map——另一处已登记保持开放的读面，不在本钉范围，
  // 不会误伤）。
  const bare = src.match(/events\.filter\(\(e\) => e\.type === "run\.state_change"\)\.at\(-1\)/g) ?? [];
  assert.equal(bare.length, 0, "不得回退为无绑定 .at(-1) 直取末条 state_change");
});

// =====================================================================
// R20 读绑定家族末簇收口（TD-128；2026-08-19，Owner 批准 + coder_mm 语义裁定）
//
//   M1 runStatus.js:137/:147/:150 —— state/terminal/last/lastActivity 经
//       metrics.js boundReportScope 收窄（同函数 agentId/executionStage 既有
//       绑定纪律的补齐）。legacy 选择（DEViation 声明）：纯 R15 过滤会破坏
//       cli.test.js TD-75 系列钉住的 pre-envelope JSON 契约（无信封 bare 行的
//       状态推断/心跳），故该面取 R18 W1 报表类 SSOT（boundReportScope）语义
//       ——全无信封保持历史读法，任一事件带信封即严格绑定，混信封下不可归属
//       降级 pending。M2 runList / M3 runs summary·dashboard 同款同理。
//   M4 runDiagnosis.js:63-64 + diagnosis.js —— 诊断 state/terminal 与全部
//       失败分类事实绑定到请求 runId（evs 顶层收窄；锚点清单外同函数同族
//       读取一并覆盖）。legacy 行为选择（锚点复核既有语义后与 M1-M3 同取
//       boundReportScope 语义）：全无信封保持历史分类（frictionLog TD-92
//       契约钉住——debug 模式对无信封失败 transcript 仍要分类写档）；任一
//       信封即严格绑定，零绑定事件 → 既有空输入降级 {category:"unknown"} +
//       state "pending"，不 throw。
//   M6 :2080 —— waitForCompletion 流后外部终态采纳绑定（交付侧 :2192 的
//       交付丢失向量探针在 test/delivery/runDeliveryReadBinding.test.js）。
//   M7 daemon.js:104/:147/:149/:506 —— scanResumableRuns/scanAllRuns/
//       IPC status 兜底绑定到 stem/请求 runId（关卡序 ①findState ②owner
//       心跳不变；孤儿恢复效应）。
//   L3 backgroundRunner.js:250/:297/:338 —— 启动/解析失败落盘前的终态检查
//       绑定（伪终态尾条不再压制 run.error/failed 落盘）。
//   L4 混合信封语义钉 —— 部分行带信封 + 部分裸行 → 只从绑定子集投影
//       （与 R18 boundReportScope 语义一致的方向性钉）。
//
// 探针诚实口径（同本文件既有各节）：只验跨 run/无信封形状；同 runId 追加
// 伪造 = runs/ 写权限攻击面，读侧无解。篡改尾条优先用【外 run 信封的 legacy
// 终态 fact】（run.completed/run.aborted/run.error）——findState 的 legacy
// 推断路径使尾部伪终态在修复前的无绑定读下真实可达，且不同时武装 L2 登记
// 不修的写侧 CAS（_detectExistingTerminal 只认 state_change；TD-128 L2）。
// =====================================================================

// ----- M1：runStatus state/terminal/last/lastActivity -----

test("R20-ST-1: 篡改探针 — 外 run 伪终态/伪活动尾条不再翻转 run_status 的 state/terminal/last/lastActivity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-st1-"));
  try {
    const runId = "run_r20_st1";
    const lines = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event", ts: "2026-08-19T00:00:03.000Z", seq: 3 },
      { type: "run.event", kind: "command", command: "rg TODO", runId, agentId: "coder_low", ts: "2026-08-19T00:00:04.000Z", seq: 4 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // 外 run 尾条两连：伪 completed 终态 + 伪活动行（修复前分别赢得 findState
    // 末条语义与 last/lastActivity 反查）。
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.completed", runId: "run_evil", agentId: "coder_low",
    });
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.event", kind: "message", role: "assistant", parts: [], runId: "run_evil", agentId: "coder_low",
    });

    const s = await getRunStatus({ runId, runDir: dir, nowFn: () => Date.parse("2026-08-19T00:01:00.000Z") });
    assert.equal(s.state, "running", "state 只由本 run 绑定事件计算（修复前外 run completed 尾条 → completed）");
    assert.equal(s.terminal, false, "外 run 伪终态尾条不再翻成终态");
    assert.equal(s.lastEventType, "run.event", "last 取绑定作用域内末条（本 run 的 command run.event）");
    assert.equal(s.lastEventTs, "2026-08-19T00:00:04.000Z", "last 的事实行/时间戳不再由外 run 尾条供给");
    assert.equal(s.lastActivityKind, "跑命令", "lastActivity 反查只看绑定 run.event（修复前外 run 伪 message 尾条胜出）");
    assert.match(s.lastActivitySummary, /rg TODO/, "活动摘要来自本 run 自身命令");
  } finally { cleanupDir(dir); }
});

test("R20-ST-2: 合法 + legacy 回归 — 全绑定输入恒等；全无信封 legacy transcript 保持历史推断（TD-75 契约）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-st2-"));
  try {
    // (a) 全绑定终态：输出与修复前逐字节一致（过滤器恒等）。
    const runId = "run_r20_st2a";
    const bound = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.event", kind: "command", command: "ls", runId, agentId: "coder_low", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "failed", reason: "backend_error", ts: "2026-08-19T00:00:02.000Z", seq: 3 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${bound.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const a = await getRunStatus({ runId, runDir: dir, nowFn: () => Date.parse("2026-08-19T00:01:00.000Z") });
    assert.equal(a.state, "failed");
    assert.equal(a.terminal, true);
    assert.equal(a.lastActivityTs, "2026-08-19T00:00:01.000Z", "绑定 run.event 照常供给心跳");

    // (b) 全无信封 legacy（TD-75 形状）：boundReportScope 无法绑定 → 历史读法
    //     照常推断状态与心跳（cli.test.js TD-75 系列钉住的契约，M1 的 DEViation
    //     理由——观测面不因绑定破坏 legacy JSON 契约）。
    const legacyId = "run_r20_st2b";
    const legacy = [
      { type: "run.submitted", agentId: "coder_hq", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.event", kind: "command", command: "ls", agentId: "coder_hq", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
      { type: "run.error", phase: "wait", error: "process exited with code 1", agentId: "coder_hq", ts: "2026-08-19T00:00:02.000Z", seq: 3 },
      { type: "run.state_change", to: "failed", reason: "backend_error", agentId: "coder_hq", ts: "2026-08-19T00:00:02.000Z", seq: 4 },
    ];
    writeFileSync(join(dir, `${legacyId}.jsonl`), `${legacy.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const b = await getRunStatus({ runId: legacyId, runDir: dir, nowFn: () => Date.parse("2026-08-19T00:01:00.000Z") });
    assert.equal(b.state, "failed", "legacy 无信封 → 历史推断保持（修复前后一致）");
    assert.equal(b.terminal, true);
    assert.equal(b.lastActivityKind, "跑命令", "legacy bare run.event 照常供给心跳（TD-75）");
  } finally { cleanupDir(dir); }
});

// ----- L4：混合信封语义钉（部分行带信封 + 部分裸行 → 只从绑定子集投影） -----

test("R20-L4-1: 方向性钉 — 混合信封 transcript 只从绑定子集投影（裸行在任一信封存在时不可见）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-l4-"));
  try {
    const runId = "run_r20_l4";
    // 混合形状：一条绑定 state_change + 一条裸（无信封）run.submitted + 一条
    // 裸 run.event 活动。任一信封存在 → 严格绑定：裸行不可见（与 R18
    // boundReportScope 语义一致——宁可可见地缺事实，不采信不可归属的行）。
    const lines = [
      { type: "run.submitted", agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
      { type: "run.event", kind: "command", command: "bare-invisible", agentId: "coder_low", ts: "2026-08-19T00:00:02.000Z", seq: 3 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

    const s = await getRunStatus({ runId, runDir: dir, nowFn: () => Date.parse("2026-08-19T00:01:00.000Z") });
    assert.equal(s.state, "running", "状态来自绑定子集");
    assert.equal(s.lastActivityTs, null, "裸 run.event 不可见 → 无心跳（不采信不可归属的活动行）");
    assert.equal(s.lastActivityKind, null);
    assert.equal(s.lastEventType, "run.state_change", "last 只取绑定子集内末条（裸 run.submitted 在前亦不可见）");
  } finally { cleanupDir(dir); }
});

// ----- M2：runList 每行 state/terminal（stem 权威） -----

test("R20-LST-1: 篡改探针 — runs list 每行 state/terminal 只由本 run 绑定事件计算（stem 即权威 runId）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-lst1-"));
  try {
    const runId = "run_r20_lst1";
    const lines = [
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.completed", runId: "run_evil", agentId: "coder_low",
    });

    const { runs } = await listRuns({ runDir: dir, knownAgentIds: [], validateAgentIds: false });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, "running", "行状态只由本 run 绑定事件计算（修复前外 run completed 尾条 → completed/terminal）");
    assert.equal(runs[0].terminal, false);
  } finally { cleanupDir(dir); }
});

test("R20-LST-2: 合法回归 + 兼容形状钉 — 全绑定行照常 completed/terminal；extractRunFacts 缺省 runId 保持历史读法（runSummaryCache 兼容）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-lst2-"));
  try {
    // (a) 全绑定终态行照常（过滤器恒等）。
    const runId = "run_r20_lst2a";
    const bound = [
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-19T00:00:02.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${bound.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const { runs } = await listRuns({ runDir: dir, knownAgentIds: [], validateAgentIds: false });
    assert.equal(runs[0].state, "completed");
    assert.equal(runs[0].terminal, true);

    // (b) 兼容形状：extractRunFacts(events)（无 runId——runSummaryCache 的
    //     extractFactsFn 调用形状）对全绑定输入保持同值。
    const factsNoId = extractRunFacts(bound);
    const factsWithId = extractRunFacts(bound, runId);
    assert.equal(factsNoId.state, "completed");
    assert.equal(factsWithId.state, "completed", "提供了 stem 时全绑定输入上两者恒等");

    // (c) 降级方向钉：信封存在但零绑定（整份只有外 run 信封行）→ 不可归属
    //     降级 pending（宁可见地缺事实）。
    const factsForeign = extractRunFacts([
      { type: "run.started", runId: "run_evil", agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.completed", runId: "run_evil", agentId: "coder_low", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
    ], runId);
    assert.equal(factsForeign.state, "pending", "零绑定事件 → findState([]) = pending");
    assert.equal(factsForeign.terminal, false);
  } finally { cleanupDir(dir); }
});

// ----- M3：runs summary byState/latest（stem 逐文件绑定） -----

test("R20-SUM-1: 篡改探针 — runs summary 的 byState/latest 不再被外 run 尾条污染", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-sum1-"));
  try {
    const runId = "run_r20_sum1";
    const lines = [
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-19T00:00:10.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // 外 run 尾条两连：伪 failed 终态 + 远期 ts（修复前分别赢得 findState 末条
    // 胜出与 latest 末事件 ts 比较）。
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.error", phase: "wait", error: "x", runId: "run_evil", agentId: "coder_low",
    });
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.completed", runId: "run_evil", agentId: "coder_low",
      ts: "2026-08-19T00:20:00.000Z",
    });

    const r = runCli(["runs", "summary", "--format", "json"], dir);
    assert.equal(r.status, 0, `CLI 成功（stderr: ${r.stderr}）`);
    const s = JSON.parse(r.stdout);
    assert.deepEqual(s.byState, { completed: 1 }, "byState 只由本 run 绑定事件计算（修复前外 run 伪 failed 尾条 → failed 计数）");
    assert.equal(s.latest, "2026-08-19T00:00:10.000Z", "latest 取最后【绑定】事件 ts（修复前被外 run 远期 ts 拉走）");
  } finally { cleanupDir(dir); }
});

test("R20-SUM-2: 合法 + legacy 回归 — 全绑定照常；全无信封 legacy 文件保持历史推断计入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-sum2-"));
  try {
    // (a) 全绑定 completed。
    const boundId = "run_r20_sum2a";
    const boundLines = [
      { type: "run.started", runId: boundId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId: boundId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-19T00:00:10.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${boundId}.jsonl`), `${boundLines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // (b) pre-envelope legacy：全部行无 runId（runs.test.js 既有契约——legacy
    //     state_change 推断照常计入聚合）。
    const legacyId = "run_r20_sum2b";
    const legacyLines = [
      { type: "run.started", backend: "claude-code", agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", from: "running", to: "running", reason: "first_event", agentId: "coder_low", ts: "2026-08-19T00:00:05.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${legacyId}.jsonl`), `${legacyLines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

    const r = runCli(["runs", "summary", "--format", "json"], dir);
    assert.equal(r.status, 0);
    const s = JSON.parse(r.stdout);
    assert.equal(s.total, 2);
    assert.deepEqual(s.byState, { completed: 1, running: 1 }, "全绑定文件照常聚合；legacy 无信封文件保持历史读法照常计入");
  } finally { cleanupDir(dir); }
});

// ----- M3：buildDashboard 行（state/tokens/cost/evidence/flagged） -----

test("R20-DB-1: 篡改探针 + 合法/legacy 回归 — dashboard 行只从本 run 绑定事实投影", () => {
  const ownStarted = { type: "run.started", runId: "run_r20_db", agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 };
  const ownCompleted = { type: "run.state_change", runId: "run_r20_db", agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-19T00:00:10.000Z", seq: 2 };

  // (a) 篡改：外 run 尾条三连——伪 failed 终态 state_change（findState 末条胜出）、
  //     伪 run.metrics（本 run 无 metrics → 无绑定读法下外 run 行首中）、伪
  //     scorecard（evidence 投影首中）。buildDashboard 是纯只读聚合——外 run
  //     state_change 形状在此无写侧 CAS 干扰（L2 只在写入车道）。
  const tampered = [
    ownStarted, ownCompleted,
    { type: "run.state_change", runId: "run_evil", agentId: "coder_low", from: "completed", to: "failed", reason: "evil", ts: "2026-08-19T00:00:20.000Z", seq: 90 },
    { type: "run.metrics", runId: "run_evil", agentId: "coder_low", tokens: { input: 99999 }, costUsd: 99, ts: "2026-08-19T00:00:21.000Z", seq: 91 },
    { type: "scorecard.checked", runId: "run_evil", agentId: "coder_low", passed: false, checks: [{ name: "forge", passed: false }], ts: "2026-08-19T00:00:22.000Z", seq: 92 },
  ];
  const dashT = buildDashboard([{ runId: "run_r20_db", events: tampered }]);
  assert.equal(dashT.rows[0].state, "completed", "行状态只由本 run 绑定事件计算（修复前外 run 伪 failed state_change 末条胜出）");
  assert.equal(dashT.rows[0].flagged, false, "不再被外 run 伪 failed 标红");
  assert.deepEqual(dashT.rows[0].tokens, {}, "本 run 无绑定 metrics → tokens 空（修复前采信外 run 99999）");
  assert.equal(dashT.rows[0].costUsd, undefined, "cost 不采信外 run 伪值（修复前 99）");
  assert.equal(dashT.rows[0].evidence, "-", "外 run 伪 scorecard 不再供给证据投影");
  assert.deepEqual(dashT.summary.byState, { completed: 1 });

  // (b) 合法回归：本 run 绑定 scorecard.warn 照常标红（M8-1/M8-2 联动不变）。
  const legalWarn = [
    ownStarted, ownCompleted,
    { type: "scorecard.checked", runId: "run_r20_db", agentId: "coder_low", passed: false, checks: [], ts: "2026-08-19T00:00:11.000Z", seq: 3 },
    { type: "scorecard.warn", runId: "run_r20_db", agentId: "coder_low", detail: "no evidence", ts: "2026-08-19T00:00:12.000Z", seq: 4 },
  ];
  const dashW = buildDashboard([{ runId: "run_r20_db", events: legalWarn }]);
  assert.equal(dashW.rows[0].flagged, true, "本 run 自身 warn 事实照常标红（合法路径零变化）");

  // (c) legacy 回归：全无信封（cli.test.js M8-2 系列形状）保持历史推断。
  const dashL = buildDashboard([{ runId: "run_r20_db_legacy", events: [
    { type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.state_change", to: "completed", ts: "2026-06-26T10:02:00.000Z" },
  ] }]);
  assert.equal(dashL.rows[0].state, "completed", "legacy 无信封 → 历史读法保持");
});

// ----- M4：runDiagnosis + diagnoseFailure -----

test("R20-DIAG-1: 篡改探针 — 外 run 尾条不再抢诊断分类/翻转终态（分类事实全量绑定）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-diag1-"));
  try {
    // (a) 本 run 诚实 crash（exit 1）+ 外 run 伪 401 run.error 尾条：修复前
    //     authError 的 events.find 首中采信外 run 行 → provider_auth（错误归因）。
    const runId = "run_r20_diag1a";
    const lines = [
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.error", phase: "wait", error: "process exited with code 1", runId, agentId: "coder_low", ts: "2026-08-19T00:00:02.000Z", seq: 2 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "failed", reason: "backend_error", ts: "2026-08-19T00:00:03.000Z", seq: 3 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.error", phase: "wait", error: "401 Unauthorized", runId: "run_evil", agentId: "coder_low",
    });
    const a = await getRunDiagnosis({ runId, runDir: dir });
    assert.equal(a.state, "failed");
    assert.equal(a.category, "crash", "分类只读本 run 绑定事实（修复前外 run 伪 401 尾条抢归 provider_auth）");

    // (b) 本 run 诚实 failed + 外 run 伪 completed 尾条：修复前 state 被读成
    //     completed → completed 短路 {category:"none"}（失败被掩盖）。
    const runId2 = "run_r20_diag1b";
    const lines2 = [
      { type: "run.started", runId: runId2, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId: runId2, agentId: "coder_low", from: "running", to: "failed", reason: "backend_error", ts: "2026-08-19T00:00:03.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${runId2}.jsonl`), `${lines2.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    appendForeignLine(join(dir, `${runId2}.jsonl`), {
      type: "run.completed", runId: "run_evil", agentId: "coder_low",
    });
    const b = await getRunDiagnosis({ runId: runId2, runDir: dir });
    assert.equal(b.state, "failed", "诊断 state 只由本 run 绑定事件计算（修复前 completed）");
    assert.equal(b.terminal, true);
    assert.equal(b.category, "unknown", "本 run 自身 failed 无更多信号 → 既有 unknown（修复前 completed 短路 none）");

    // (c) 内核直调同款：diagnoseFailure(events, runId) 的 evs 顶层过滤。
    const kernel = diagnoseFailure([
      ...lines2,
      { type: "run.completed", runId: "run_evil", agentId: "coder_low", ts: "2026-08-19T00:00:09.000Z", seq: 99 },
    ], runId2);
    assert.equal(kernel.category, "unknown", "内核分类同款绑定（无 second copy）");
  } finally { cleanupDir(dir); }
});

test("R20-DIAG-2: 合法回归 + legacy 降级钉 — 全绑定分类照常；不可归属降级 unknown/pending 不 throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-diag2-"));
  try {
    // (a) 合法回归：全绑定 401 → provider_auth（M12-6 FR-02 契约零变化）。
    const runId = "run_r20_diag2a";
    const lines = [
      { type: "run.state_change", runId, agentId: "coder_low", to: "failed", reason: "x", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.error", phase: "wait", error: "Error: 401 Unauthorized", runId, agentId: "coder_low", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const a = await getRunDiagnosis({ runId, runDir: dir });
    assert.equal(a.category, "provider_auth");
    assert.equal(a.code, "unauthorized", "closed-set code 照常投影");

    // (b) legacy 语义钉（锚点复核既有语义后的选择）：全无信封 transcript 保持
    //     历史推断分类（frictionLog TD-92 契约钉住——debug 模式对无信封失败
    //     transcript 仍要分类写档；boundReportScope 语义）。
    const legacyId = "run_r20_diag2b";
    const legacy = [
      { type: "run.started", backend: "claude-code", agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.error", phase: "wait", error: "process exited with code 1", agentId: "coder_low", ts: "2026-08-19T00:00:02.000Z", seq: 2 },
      { type: "run.state_change", to: "failed", reason: "backend_error", agentId: "coder_low", ts: "2026-08-19T00:00:03.000Z", seq: 3 },
    ];
    writeFileSync(join(dir, `${legacyId}.jsonl`), `${legacy.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const b = await getRunDiagnosis({ runId: legacyId, runDir: dir });
    assert.equal(b.state, "failed", "全无信封 legacy → 历史推断保持（frictionLog TD-92 契约）");
    assert.equal(b.terminal, true);
    assert.equal(b.category, "crash", "legacy 分类读法保持（与 frictionLog 同一内核调用）");

    // (b2) 降级方向钉：信封存在但零绑定（整份只有外 run 信封行）→ state
    //      pending + category unknown（不可归属永不投影终态/编造分类，不 throw）。
    const foreignOnlyId = "run_r20_diag2c";
    const foreignOnly = [
      { type: "run.started", runId: "run_evil", agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.error", phase: "wait", error: "401 Unauthorized", runId: "run_evil", agentId: "coder_low", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
      { type: "run.state_change", runId: "run_evil", agentId: "coder_low", from: "running", to: "failed", reason: "backend_error", ts: "2026-08-19T00:00:02.000Z", seq: 3 },
    ];
    writeFileSync(join(dir, `${foreignOnlyId}.jsonl`), `${foreignOnly.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const c = await getRunDiagnosis({ runId: foreignOnlyId, runDir: dir });
    assert.equal(c.state, "pending", "零绑定事件 → pending（观测面降级不设门）");
    assert.equal(c.terminal, false);
    assert.equal(c.category, "unknown", "零绑定事件 → 既有 unknown 降级（不 throw、不编造分类）");

    // (c) 内核兼容形状：diagnoseFailure(events)（无 expectedRunId）保持历史
    //     无绑定读法（既有调用方契约不变——同 (b) 输入仍按 legacy 推断分类）。
    const kernelNoId = diagnoseFailure(legacy);
    assert.equal(kernelNoId.category, "crash", "缺省 expectedRunId → 历史读法（M9-5A-01 等既有契约）");
  } finally { cleanupDir(dir); }
});

// ----- M6（:2080 面）：waitForCompletion 流后外部终态采纳 -----
//（交付丢失向量 :2192 的探针在 test/delivery/runDeliveryReadBinding.test.js——
// 该 lane 需要 delivery 上下文与打包器注入。此处钉非交付的采纳面：done-only
// replay backend 不写 running state_change，start 后追加的外 run legacy 终态
// fact 在修复前的无绑定 findState 下真实可达。）

test("R20-EXT-1: 篡改探针 — 流后外部终态采纳绑定本 run：外 run 伪 aborted 尾条不再被采纳为外部终态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-ext1-"));
  try {
    const { backend } = makeReplayBackend();
    const manager = makeManager(dir, backend);
    const runId = "run_r20_ext1";
    const run = await manager.start("proc_agent", { prompt: "original prompt", runId });
    // 外 run 伪终态 fact 尾条（本 run 自身最后一条 state_change 之后）：修复前
    // :2080 的无绑定 findState 经 legacy 反查读到 aborted → 采纳 → loser aborted
    // （backend 的 done(completed) 诚实完成被伪尾条劫持）。
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.aborted", runId: "run_evil", agentId: "test-agent",
    });
    const result = await run.waitForCompletion({ waitTimeout: 2000, pollInterval: 10 });
    assert.equal(result.completed, true, "本 run 自身完成路径照常（修复前采纳外 run aborted → completed:false/aborted:true）");
    const events = await readTranscript(join(dir, `${runId}.jsonl`));
    assert.equal(findState(events), "completed", "落盘终态 = 本 run 自身 completed");
  } finally { cleanupDir(dir); }
});

// ----- M7：daemon 扫描与 IPC status 兜底 -----

test("R20-DM-1: 篡改探针 + 合法回归 — scanResumableRuns 终态判定绑定 stem（孤儿恢复：伪终态尾条不再永久压制 resume 候选）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-dm1-"));
  try {
    // 篡改：在飞 run（绑定 running）+ 外 run completed 尾条。修复前 findState
    // 读成 completed → 永久跳过（孤儿被伪终态压制，daemon 重启永不接管）；
    // 绑定后按本 run 自身非终态放行给 owner 心跳关。
    const runId = "run_r20_dm1";
    const lines = [
      { type: "run.created", runId, agentId: "test_agent", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId, agentId: "test_agent", from: "submitted", to: "running", reason: "first_event", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.completed", runId: "run_evil", agentId: "test_agent",
    });
    const resumable = scanResumableRuns(dir, 10_000, 60_000);
    assert.ok(resumable.includes(runId), "绑定后本 run 自身非终态 → resume 候选照常放行（修复前外 run completed 尾条 → 永久压制）");

    // 合法回归：本 run 自身终态 → 照常跳过（关卡序 ①不变）。
    const doneId = "run_r20_dm1_done";
    const doneLines = [
      { type: "run.created", runId: doneId, agentId: "test_agent", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId: doneId, agentId: "test_agent", from: "running", to: "completed", reason: "done", ts: "2026-08-19T00:00:02.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${doneId}.jsonl`), `${doneLines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const resumable2 = scanResumableRuns(dir, 10_000, 60_000);
    assert.ok(!resumable2.includes(doneId), "本 run 自身终态 → 照常跳过（不复活已完成的 run）");
    assert.ok(resumable2.includes(runId));
  } finally { cleanupDir(dir); }
});

test("R20-DM-2: 篡改探针 + 合法回归 — scanAllRuns 行 state/agentId 与 IPC status 兜底绑定（统一视图/请求 runId）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-dm2-"));
  try {
    // 篡改：本 run 在飞（绑定行不带 agentId——JsonlTranscript 会带，此处钉
    // 绑定读取器不采信外 run 行的 agentId）+ 外 run completed 尾条 + 外 run
    // agentId 行。修复前 state 读成 completed → 行从统一视图消失；agentId 取
    // 全量首中（外 run 行可供给）。
    const runId = "run_r20_dm2";
    const lines = [
      { type: "run.created", runId, ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId, from: "submitted", to: "running", reason: "first_event", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    appendForeignLine(join(dir, `${runId}.jsonl`), {
      type: "run.completed", runId: "run_evil", agentId: "evil_agent",
    });

    const runs = scanAllRuns(dir, 10_000, 60_000, new Set());
    assert.equal(runs.length, 1, "在飞 run 不被外 run 伪终态尾条从统一视图抹掉");
    assert.equal(runs[0].state, "running", "行 state 只由本 run 绑定事件计算");
    assert.equal(runs[0].agentId, "unknown", "外 run 行不供给 agentId（本 run 绑定行无 agentId → 既有 unknown 降级）");
    assert.equal(runs[0].owner, "orphan", "owner 分类照常（关卡序 ②不变——无 owner 文件 → orphan）");

    // IPC status 兜底（run 不在 daemon 内存）：state 绑定请求 runId。
    const fakeManager = { activeRuns: new Map(), list: () => [] };
    const res = await handleRequest({ cmd: "status", runId }, fakeManager, { runDir: dir });
    assert.equal(res.ok, true);
    assert.equal(res.state, "running", "IPC status 兜底读绑定请求 runId（修复前外 run completed 尾条 → completed）");
    assert.equal(res.live, false);

    // 合法回归：本 run 自身终态 → 统一视图照常跳过。
    const doneId = "run_r20_dm2_done";
    const doneLines = [
      { type: "run.created", runId: doneId, agentId: "test_agent", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId: doneId, agentId: "test_agent", from: "running", to: "aborted", reason: "user", ts: "2026-08-19T00:00:02.000Z", seq: 2 },
    ];
    writeFileSync(join(dir, `${doneId}.jsonl`), `${doneLines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const runs2 = scanAllRuns(dir, 10_000, 60_000, new Set());
    assert.equal(runs2.length, 1, "本 run 自身终态照常跳过");
    assert.equal(runs2[0].runId, runId);
  } finally { cleanupDir(dir); }
});

// ----- L3：backgroundRunner 启动/解析失败落盘（:250/:297/:338） -----

test("R20-BR-1: 篡改探针 — 启动失败落盘不被外 run 伪终态尾条压制（run.error + failed 照常写入）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-br1-"));
  try {
    const runId = "run_r20_br1";
    // CLI 派发形状的既有 transcript（绑定 background_submitted + pending）。
    const t = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "coder_hq" });
    await t.append("run.background_submitted", { background: true, cwd: dir });
    await t.transitionState(null, "pending", "background_spawned");
    // 外 run 伪终态尾条（fact 形状——修复前 findState legacy 反查读到 completed
    // → :250 提前 return，启动失败被静默吞掉；fact 不武装 L2 写侧 CAS）。
    appendForeignLine(t.filePath, {
      type: "run.completed", runId: "run_evil", agentId: "coder_hq",
    });

    const result = await runBackground({
      agentId: "missing_agent", prompt: "x",
      registry: { agents: {} }, runDir: dir, runId,
      waitTimeout: 1000, pollInterval: 10,
    });
    assert.equal(result.failed, true, "启动失败结果如实 failed");
    const events = await readTranscript(t.filePath);
    assert.ok(events.some((e) => e.type === "run.error" && e.phase === "start"),
      "run.error 照常落盘（修复前伪终态尾条压制 → 静默吞掉启动失败）");
    assert.equal(findState(events), "failed", "本 run 自身 failed 终态照常落盘");
  } finally { cleanupDir(dir); }
});

test("R20-BR-2: 合法回归 + runMain 解析失败车道同款绑定 — 无尾条照常落盘；伪终态尾条不再压制 delivery/reuse-worktree 解析失败", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-br2-"));
  const prevGuard = process.env.WAO_SKIP_VERSION_GUARD;
  process.env.WAO_SKIP_VERSION_GUARD = "1";
  try {
    // (a) runMain 的 delivery-json 解析失败车道（:297）：外 run 伪终态尾条下
    //     run.error(delivery_parse) + failed 照常落盘。
    const runId = "run_r20_br2a";
    const t = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "coder_hq" });
    await t.append("run.background_submitted", { background: true, cwd: dir });
    await t.transitionState(null, "pending", "background_spawned");
    appendForeignLine(t.filePath, { type: "run.completed", runId: "run_evil", agentId: "coder_hq" });
    await runMain([
      "coder_hq", "--prompt", "x", "--run-dir", dir, "--run-id", runId,
      "--delivery-json", "{not-json",
    ]);
    const eventsA = await readTranscript(t.filePath);
    assert.ok(eventsA.some((e) => e.type === "run.error" && e.phase === "delivery_parse"),
      "解析失败 run.error 照常落盘（修复前伪终态尾条 → 跳过落盘）");
    assert.equal(findState(eventsA), "failed");

    // (b) reuse-worktree 解析失败车道（:338）同款 + 对照（无尾条照常）。
    const runId2 = "run_r20_br2b";
    const t2 = new JsonlTranscript(join(dir, `${runId2}.jsonl`), { runId: runId2, agentId: "coder_hq" });
    await t2.append("run.background_submitted", { background: true, cwd: dir });
    await t2.transitionState(null, "pending", "background_spawned");
    appendForeignLine(t2.filePath, { type: "run.aborted", runId: "run_evil", agentId: "coder_hq" });
    await runMain([
      "coder_hq", "--prompt", "x", "--run-dir", dir, "--run-id", runId2,
      "--reuse-worktree-json", "{bad",
    ]);
    const eventsB = await readTranscript(t2.filePath);
    assert.ok(eventsB.some((e) => e.type === "run.error" && e.phase === "reuse_worktree_parse"),
      "reuse-worktree 解析失败 run.error 照常落盘");
    assert.equal(findState(eventsB), "failed");

    const runId3 = "run_r20_br2c";
    const t3 = new JsonlTranscript(join(dir, `${runId3}.jsonl`), { runId: runId3, agentId: "coder_hq" });
    await t3.append("run.background_submitted", { background: true, cwd: dir });
    await t3.transitionState(null, "pending", "background_spawned");
    await runMain([
      "coder_hq", "--prompt", "x", "--run-dir", dir, "--run-id", runId3,
      "--delivery-json", "{not-json",
    ]);
    const eventsC = await readTranscript(t3.filePath);
    assert.ok(eventsC.some((e) => e.type === "run.error" && e.phase === "delivery_parse"),
      "合法回归：无尾条时解析失败照常落盘（既有行为零变化）");
    assert.equal(findState(eventsC), "failed");
  } finally {
    if (prevGuard === undefined) delete process.env.WAO_SKIP_VERSION_GUARD;
    else process.env.WAO_SKIP_VERSION_GUARD = prevGuard;
    cleanupDir(dir);
  }
});

// =====================================================================
// R20-C 终审返工（TD-128；2026-08-19，R20 双席终审 coder_mm + auditor 会聚）
//
//   C-1 runs prune（双席会聚 P2，本包最重）：cutoff 删除决策的年龄读取
//       （events.at(-1).ts）绑定到【文件名 stem 即权威 runId】的信封绑定事件
//       （boundReportScope，与 runs summary R20 改法同款）。注册危害：外 run
//       旧 ts 尾条直接驱动 unlink——证据灭失面，重于全部观测面。
//   C-2 runs wait SIGINT 快照：中断路径 findState(events) 绑定到请求 runId
//       （service R19 已绑定而快照漏绑——"同一 SSOT"注释一度失真，本轮补齐
//       重新为真）。
//   C-3 runWait countProgressAfterSeq：进度计数经 boundReportScope 收窄——
//       外 run 高 seq 活动行不再伪造 "progress"（经 summarizeLiveness 上
//       run_wait / run_await_result 的 wire；activityEventCount 是 Lead stop
//       决策喂料的机器消费字段）。
//   C-4 runs dashboard --latest：排序键 = 各 run 自身【绑定】事件的末条 ts——
//       外 run 远期尾条不再顶掉行序。
//
// 探针诚实口径（同本文件既有各节）：只验跨 run/无信封形状；同 runId 追加
// 伪造 = runs/ 写权限攻击面，读侧无解。legacy 选择（boundReportScope 自身
// 规则）：全无信封文件保持历史读法（PR-2/DB-1 legacy 腿钉住）；任一事件带
// 信封即严格绑定，混信封下不可归属 = 零可见（L4 同向）。
// =====================================================================

// ----- C-1：runs prune cutoff 删除决策（CLI） -----

test("R20C-PR-1: 篡改探针 — 外 run 旧 ts 尾条不再把在役 run 驱动进 prune 删除（修复前直接 unlink）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20c-pr1-"));
  try {
    const keepId = "run_r20c_keep";
    const recentTs = new Date().toISOString();
    const lines = [
      { type: "run.started", runId: keepId, agentId: "coder_low", ts: recentTs, seq: 1 },
      { type: "run.state_change", runId: keepId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event", ts: recentTs, seq: 2 },
    ];
    writeFileSync(join(dir, `${keepId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // 外 run 旧 ts 尾条（ts 相对墙钟取旧——不依赖固定日期）：修复前
    // events.at(-1).ts 供给 cutoff 判龄 → 远老于 cutoff → 该在役 run 被 unlink。
    const oldTs = new Date(Date.now() - 8 * 86_400_000).toISOString();
    appendFileSync(join(dir, `${keepId}.jsonl`), `${JSON.stringify({
      type: "run.completed", runId: "run_evil", agentId: "coder_low", ts: oldTs, seq: 99,
    })}\n`, "utf8");

    const r = runCli(["runs", "prune", "--older-than", "1h"], dir);
    assert.equal(r.status, 0, `CLI 成功（stderr: ${r.stderr}）`);
    assert.ok(r.stdout.includes("Pruned 0, kept 1"),
      `在役 run 不被外 run 旧 ts 尾条翻成可修剪（修复前 Pruned 1 → unlink；实际输出：${r.stdout}）`);
    assert.ok(existsSync(join(dir, `${keepId}.jsonl`)),
      "证据未灭失——文件仍在（修复前被 unlink）");
  } finally { cleanupDir(dir); }
});

test("R20C-PR-2: 合法 + legacy 回归 — 自身旧 ts 的 run 照删；全无信封 legacy 文件保持历史判龄", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20c-pr2-"));
  try {
    const oldTs = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const recentTs = new Date().toISOString();
    // (a) 全绑定旧 run（自身末条 ts 老）→ 照删（合法 prune 零变化）。
    writeFileSync(join(dir, "run_r20c_old.jsonl"), `${[
      { type: "run.started", runId: "run_r20c_old", agentId: "coder_low", ts: oldTs, seq: 1 },
      { type: "run.completed", runId: "run_r20c_old", agentId: "coder_low", ts: oldTs, seq: 2 },
    ].map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // (b) 全绑定新 run → 保留。
    writeFileSync(join(dir, "run_r20c_recent.jsonl"), `${[
      { type: "run.started", runId: "run_r20c_recent", agentId: "coder_low", ts: recentTs, seq: 1 },
    ].map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // (c) pre-envelope legacy 旧文件（全部行无 runId）→ 历史读法照删（prune 扫
    //     全部 .jsonl，是最可能碰到 legacy 文件的清理面——降级不设门）。
    writeFileSync(join(dir, "run_r20c_legacy_old.jsonl"), `${[
      { type: "run.started", ts: oldTs, seq: 1 },
      { type: "messages.collected", ts: oldTs, seq: 2 },
    ].map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // (d) pre-envelope legacy 新文件 → 保留。
    writeFileSync(join(dir, "run_r20c_legacy_recent.jsonl"), `${JSON.stringify({
      type: "run.started", ts: recentTs, seq: 1,
    })}\n`, "utf8");

    const r = runCli(["runs", "prune", "--older-than", "7d"], dir);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("Pruned 2, kept 2"), `旧 run（绑定 + legacy）照删、新 run 照留（实际输出：${r.stdout}）`);
    assert.ok(!existsSync(join(dir, "run_r20c_old.jsonl")), "自身旧 ts 的绑定 run 被 prune（合法路径）");
    assert.ok(!existsSync(join(dir, "run_r20c_legacy_old.jsonl")), "legacy 无信封旧文件保持历史判龄照删");
    assert.ok(existsSync(join(dir, "run_r20c_recent.jsonl")));
    assert.ok(existsSync(join(dir, "run_r20c_legacy_recent.jsonl")));
  } finally { cleanupDir(dir); }
});

// ----- C-2：runs wait SIGINT 中断快照（进程内 process.emit 探针，runsWait.test.js D1-D3 同款模式） -----

test("R20C-SIG-1: 篡改探针 — SIGINT 中断快照的状态投影绑定 runId（外 run 伪终态尾条不再翻快照）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20c-sig1-"));
  const runId = "run_r20c_sig1";
  try {
    const lines = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
    ];
    // 外 run 伪终态尾条（state_change 末条胜出形状）：修复前快照 findState 无
    // 绑定 → completed/terminal:true。
    const tailed = [...lines, {
      type: "run.state_change", runId: "run_evil", agentId: "coder_low",
      from: "running", to: "completed", reason: "evil", ts: "2026-08-19T00:00:02.000Z", seq: 99,
    }];
    writeFileSync(join(dir, `${runId}.jsonl`), `${tailed.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

    const out = [];
    const origLog = console.log;
    const origExit = process.exit;
    let exitArg = "NOT_CALLED";
    let releaseGate;
    const gate = new Promise((_resolve, reject) => { releaseGate = reject; });
    // 本文件更早的测试（R18-RES/R20-EXT 的 makeManager）经 RunManager 安装了
    // 进程级 SIGINT 单例 handler（runManager.js installSigintHandler：await
    // gracefulShutdown 后 process.exit(130)——异步晚到会在探针 teardown 之后
    // 真杀测试进程）。快照并暂时摘除全部既有 listener，探针的 emit 只触达
    // runs wait 自己注册的 handler；finally 先让 runsCommand 注销自己的
    // handler，再原样恢复快照（单例安装标志不受影响，不双装）。
    const savedSigintListeners = process.listeners("SIGINT");
    process.removeAllListeners("SIGINT");
    let waitPromise;
    try {
      console.log = (...a) => { out.push(a.map(String).join("\t")); };
      process.exit = (code) => { exitArg = code; };
      waitPromise = runsCommand(["wait", runId, "--format", "json"], { runDir: dir }, {
        // service 挂起模拟"阻塞窗口中 Ctrl-C"；此刻 SIGINT handler 已注册。
        runWaitFn: () => { process.emit("SIGINT"); return gate; },
      });
      const deadline = Date.now() + 5000;
      while (exitArg === "NOT_CALLED" && Date.now() < deadline) {
        await new Promise((r) => setImmediate(r));
      }
      assert.notEqual(exitArg, "NOT_CALLED", "handler 必须 process.exit(1)");
      assert.equal(exitArg, 1);
      const snap = JSON.parse(out.join("\n"));
      assert.equal(snap.state, "running",
        "中断快照状态只由本 run 绑定事件计算（修复前外 run completed 尾条末条胜出 → completed）");
      assert.equal(snap.terminal, false, "外 run 伪终态尾条不再把中断快照翻成终态（修复前 terminal:true）");
      assert.equal(snap.interrupted, true);
    } finally {
      console.log = origLog;
      process.exit = origExit;
      releaseGate(new Error("r20c-sig1-teardown"));
      if (waitPromise) await waitPromise.catch(() => {});
      process.removeAllListeners("SIGINT");
      for (const listener of savedSigintListeners) process.on("SIGINT", listener);
    }
  } finally { cleanupDir(dir); }
});

// ----- C-3：liveness 进度计数绑定（内核直调 + run_wait / run_await_result 两条 wire） -----

test("R20C-LIV-1: 篡改探针 + 合法/legacy 回归 — summarizeLiveness 进度计数绑定 runId（外 run 高 seq 活动行不伪造 progress）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20c-liv1-"));
  try {
    const runId = "run_r20c_liv1";
    const own = (over = {}) => ({
      type: "run.event", kind: "tool_use", tool: "Read", runId, agentId: "coder_low",
      ts: "2026-08-19T00:00:00.000Z", ...over,
    });
    // (a) 篡改：baseline 3 之外只有外 run 高 seq 活动行（修复前 seq 99 > 3 计入
    //     → progress；绑定后不可见 → 零进展 + 无 owner 心跳 → silent）。
    const tampered = summarizeLiveness({
      events: [
        own({ seq: 1 }), own({ seq: 2 }), own({ seq: 3 }),
        { type: "run.event", kind: "command", command: "evil", runId: "run_evil", agentId: "coder_low", ts: "2026-08-19T00:00:01.000Z", seq: 99 },
      ],
      runDir: dir, runId, activityBaseline: 3, now: Date.now(),
    });
    assert.equal(tampered.liveness, "silent",
      "外 run 高 seq 活动行不计数 → silent（修复前 progress——伪进展喂给 Lead 的 stop 决策）");
    assert.equal(tampered.activityEventCount, 0, "计数为 0（修复前 1）");
    assert.equal(tampered.lastActivityKind, null, "末活动标签不由外 run 行供给（修复前 \"command\"）");

    // (b) 合法回归：本 run 自身高 seq 活动照常计数（全绑定输入恒等）。
    const legal = summarizeLiveness({
      events: [
        own({ seq: 1 }), own({ seq: 2 }), own({ seq: 3 }),
        own({ seq: 5, kind: "command", command: "npm test", exitCode: 0 }),
      ],
      runDir: dir, runId, activityBaseline: 3, now: Date.now(),
    });
    assert.equal(legal.liveness, "progress");
    assert.equal(legal.activityEventCount, 1);
    assert.equal(legal.lastActivityKind, "command");

    // (c) legacy 语义钉：全无信封快照保持历史无绑定计数（runWait.test.js
    //     WAIT-RUNTIME-1 既有契约——观测面降级不设门，任一信封才严格绑定）。
    const legacy = summarizeLiveness({
      events: [{ type: "run.event", kind: "runtime_activity", status: "provider_retry", seq: 2 }],
      runDir: dir, runId, activityBaseline: 0, now: Date.now(),
    });
    assert.equal(legacy.liveness, "progress", "全无信封 → 无法绑定 → 历史读法照常计数");
    assert.equal(legacy.activityEventCount, 1);
  } finally { cleanupDir(dir); }
});

test("R20C-LIV-2: 篡改探针 — run_wait 窗口到期的 liveness 投影绑定（poll 快照内的外 run 高 seq 活动行不再伪造 progress）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20c-liv2-"));
  try {
    const runId = "run_r20c_liv2";
    const cleanRunning = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
      { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event", ts: "2026-08-19T00:00:03.000Z", seq: 3 },
    ];
    // 首读基线 seq 3；poll 尾条外 run 活动行 seq 99（修复前 > 3 计入 → progress）。
    const tailed = [...cleanRunning, {
      type: "run.event", kind: "command", command: "evil", runId: "run_evil", agentId: "coder_low",
      ts: "2026-08-19T00:00:04.000Z", seq: 99,
    }];
    let readCalls = 0;
    const out = await runWait({
      runId, runDir: dir, waitMs: 180000,
      ...fakeWaitClock(),
      readTranscriptFn: async () => { readCalls += 1; return readCalls === 1 ? cleanRunning : tailed; },
    });
    assert.ok(readCalls >= 2, "至少一次 poll 读到带外 run 活动尾条的快照");
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.terminal, false);
    assert.equal(out.liveness, "silent",
      "外 run 高 seq 活动行不计数 → silent（修复前 progress——窗口被伪进展掩盖）");
    assert.equal(out.activityEventCount, 0, "wire 的 activityEventCount = 0（修复前 1）");
    assert.equal(out.lastActivityKind, null);
  } finally { cleanupDir(dir); }
});

test("R20C-LIV-3: 篡改探针 — run_await_result 共享同一 liveness SSOT（point-in-time afterSeq:0 的外 run 高 seq 活动行不伪造 progress）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20c-liv3-"));
  try {
    const runId = "run_r20c_liv3";
    // 本 run 自身事件均不在 PROGRESS_EVENT_TYPES（run.submitted/run.started）——
    // 唯一可计数行是外 run 高 seq 活动尾条（修复前计入 → progress）。
    const tailed = [
      { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-19T00:00:01.000Z", seq: 2 },
      { type: "run.event", kind: "tool_use", tool: "Edit", runId: "run_evil", agentId: "coder_low", ts: "2026-08-19T00:00:02.000Z", seq: 99 },
    ];
    const out = await runAwaitResult({
      runId, runDir: dir, waitMs: 0, afterSeq: 0,
      readTranscriptFn: async () => tailed,
    });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.terminal, false);
    assert.equal(out.liveness, "silent",
      "await 与 wait 共享 summarizeLiveness SSOT——外 run 活动行同款不可见（修复前 progress）");
    assert.equal(out.activityEventCount, 0, "wire 的 activityEventCount = 0（修复前 1）");
    assert.equal(out.lastActivityKind, null);
  } finally { cleanupDir(dir); }
});

// ----- C-4：runs dashboard --latest 排序键（进程内 renderOnce） -----

test("R20C-DB-1: 篡改探针 + 合法/legacy 回归 — --latest 排序键 = 各 run 自身绑定事件末条 ts（外 run 远期尾条不再顶序）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20c-db1-"));
  const out = [];
  const origLog = console.log;
  console.log = (...a) => { out.push(a.map(String).join("\t")); };
  try {
    const aId = "run_r20c_db_a";
    const bId = "run_r20c_db_b";
    // A：自身末条 ts 00:10 + 外 run 远期尾条 20:00（修复前 events.at(-1).ts
    //     供给排序键 → A 被顶到最前，顶掉真实最近者）。
    writeFileSync(join(dir, `${aId}.jsonl`), `${[
      { type: "run.started", runId: aId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId: aId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-19T00:00:10.000Z", seq: 2 },
      { type: "run.completed", runId: "run_evil", agentId: "coder_low", ts: "2026-08-19T00:20:00.000Z", seq: 99 },
    ].map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // B：真实最近者（自身末条 ts 00:20）。
    writeFileSync(join(dir, `${bId}.jsonl`), `${[
      { type: "run.started", runId: bId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.state_change", runId: bId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-19T00:00:20.000Z", seq: 2 },
    ].map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    // legacy：全无信封，末事件 ts 00:05（历史读法按末事件 ts 参与排序）。
    writeFileSync(join(dir, "run_r20c_db_leg.jsonl"), `${[
      { type: "run.submitted", agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
      { type: "run.completed", agentId: "coder_low", ts: "2026-08-19T00:00:05.000Z", seq: 2 },
    ].map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

    await runsDashboardCommand(["--latest", "1", "--format", "json", "--run-dir", dir], { runDir: dir });
    const dash1 = JSON.parse(out.join("\n"));
    assert.equal(dash1.summary.total, 1);
    assert.equal(dash1.rows[0].runId, bId,
      "--latest 1 取真实最近者 B（修复前 A 的外 run 远期尾条 20:00 顶到最前）");

    // 合法 + legacy 回归：零干扰排序 = B(00:20) > A(00:10) > legacy(00:05)。
    out.length = 0;
    await runsDashboardCommand(["--latest", "2", "--format", "json", "--run-dir", dir], { runDir: dir });
    const dash2 = JSON.parse(out.join("\n"));
    assert.deepEqual(dash2.rows.map((r) => r.runId), [bId, aId],
      "按自身绑定末条 ts 降序；legacy 无信封文件按末事件 ts 参与排序（历史读法保持，排序在后）");
  } finally {
    console.log = origLog;
    cleanupDir(dir);
  }
});
