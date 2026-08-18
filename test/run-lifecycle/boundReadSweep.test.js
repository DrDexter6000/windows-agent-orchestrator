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
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { JsonlTranscript, readTranscript } from "../../src/transcript.js";
import { collectRunMessages } from "../../src/application/runCollect.js";
import { resolveReuseTurn, resolveLineageFirstTurn, resolveLineageContinuationTurn } from "../../src/application/sessionReuse.js";
import { correctRun } from "../../src/application/runCorrection.js";
import { continueRun } from "../../src/application/runContinue.js";
import { readRunActivity } from "../../src/application/runActivity.js";
import { loadRun } from "../../src/commands/shared.js";
// R18（TD-128 W1/W2/W3 观测面卫生包）：被测面 + CLI 探针用的 runCommand 导出。
import { loadScorecardFromTranscript } from "../../src/commands/run.js";
import { runAwaitResult } from "../../src/application/runAwaitResult.js";
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
