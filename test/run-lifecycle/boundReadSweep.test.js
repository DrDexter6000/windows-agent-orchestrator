// test/run-lifecycle/boundReadSweep.test.js
//
// R14（2026-08-18，TD-128/129）：读绑定清扫包 —— R13/R13-C 修掉 retry/resume/stop
// 三 lane 后剩余同类无绑定读取的收尾探针与回归。
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
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlTranscript } from "../../src/transcript.js";
import { resolveReuseTurn, resolveLineageFirstTurn, resolveLineageContinuationTurn } from "../../src/application/sessionReuse.js";
import { correctRun } from "../../src/application/runCorrection.js";
import { continueRun } from "../../src/application/runContinue.js";
import { readRunActivity } from "../../src/application/runActivity.js";
import { loadRun } from "../../src/commands/shared.js";

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
