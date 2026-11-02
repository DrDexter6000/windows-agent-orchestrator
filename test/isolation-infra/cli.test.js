// cli.test.js
//
// 锁定 CLI 参数解析 + prompt 加载 + worker 失败通知的不变量。
// 重点：--prompt-file 必须把多行内容完整传递（PowerShell 多行 --prompt 会被截断）。
// 重点：worker failed 时主控必须收到结构化失败结果（runId/failed/error），不能裸 crash。
//
// TD-138 全量提速批（2026-11-01）拆分：原 194 例按系列分到本文件（被外部注释
// 引用最多的系列：TD-75 pre-envelope、M8-2 dashboard、R13-CLI、doctor panel、
// P1-1 认证门、runAndWait 通知）、cli-registry.test.js（registry/wao 子命令面）
// 与 cli-runs.test.js（run 派发与读侧面）。共用辅助在 _cliTestHelpers.mjs；
// 三文件用例数与断言与拆分前一致。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseOptions, loadPrompt, runAndWait, buildDashboard, runsDashboardCommand, statusCommand, resolveTargetCwd } from "../../src/cli.js";
import { readTranscript, findLatestBound, findFirstBound } from "../../src/transcript.js";
import { retryCommand } from "../../src/commands/lifecycle.js";
import { rmrfRetry, sleepSync } from "../_rmrfHelper.mjs";
import { captureLog, doctorSpawnEnv, makeDoctorPanelFixture, doctorPanelRun, makeRetryInheritFixture, parseRetryJson, writeRetrySource } from "./_cliTestHelpers.mjs";

// sleepSync + rmrfRetry (bounded transient-rm retry, injectable rm/sleep) are the
// shared test-only helpers (TD-107) — see test/_rmrfHelper.mjs + test/rmrfRetry.test.js.

test("rmrfRetry (Windows cwd-lock probe): retries EPERM while a child holds cwd; diagnostic if not reproduced", () => {
  if (process.platform !== "win32") return;

  const dir = mkdtempSync(join(tmpdir(), "wao-rmrf-retry-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 250)"], {
    cwd: dir,
    stdio: "ignore",
    windowsHide: true,
  });

  // TD-107: this probe reproduces a real Windows cwd-handle lock, but the lock is
  // timing/AV-dependent and may NOT reproduce on a given run. A non-reproduction
  // is DIAGNOSTIC ONLY (not_reproduced) — it must NEVER fail the canonical suite.
  // Only an actual lock that rmrfRetry then fails to clear is a real failure.
  let outcome = "not_reproduced";
  try {
    sleepSync(50);
    let locked = false;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "ENOTEMPTY") {
        locked = true;
      } else {
        throw error; // unexpected error — surface it
      }
    }
    if (locked) {
      rmrfRetry(dir, { retries: 20, delayMs: 50 });
      assert.equal(existsSync(dir), false, "rmrfRetry must clear a locked cwd once the handle releases");
      outcome = "reproduced_and_cleared";
    }
    assert.ok(
      outcome === "reproduced_and_cleared" || outcome === "not_reproduced",
      "cwd-lock probe outcome must be reproduced_and_cleared or not_reproduced",
    );
  } finally {
    try { child.kill(); } catch {}
    try { rmrfRetry(dir); } catch {}
  }
});

test("parseOptions: --kebab-case 自动转 camelCase（含 prompt-file → promptFile）", () => {
  const opts = parseOptions(["--prompt-file", "task.txt", "--wait-timeout", "5000"]);
  assert.equal(opts.promptFile, "task.txt", "--prompt-file 必须映射到 promptFile");
  assert.equal(opts.waitTimeout, "5000", "--wait-timeout 必须映射到 waitTimeout");
});

// TD-84：resolveTargetCwd 回退链——跨项目 scope 修复
// dogfood 发现 worker 调 wao 命令时记录写错项目（写进 Lead repo 而非干活的目标项目）。
// 回退链：--cwd > WAO_TARGET_CWD env > process.cwd()。worker 子进程被注入 WAO_TARGET_CWD，
// 所以 worker 这一路自动正确；Lead 跨项目派工时需显式带 --cwd（SKILL 纪律）。

test("TD-84: resolveTargetCwd 显式 --cwd 优先于 env 和 process.cwd()", () => {
  const prevEnv = process.env.WAO_TARGET_CWD;
  try {
    process.env.WAO_TARGET_CWD = "/tmp/env-target";
    const cwd = resolveTargetCwd({ cwd: "/tmp/explicit" });
    assert.equal(cwd, resolve("/tmp/explicit"), "显式 --cwd 必须最优先，覆盖 env");
  } finally {
    if (prevEnv === undefined) delete process.env.WAO_TARGET_CWD;
    else process.env.WAO_TARGET_CWD = prevEnv;
  }
});

test("TD-84: resolveTargetCwd 无 --cwd 时读 WAO_TARGET_CWD（worker 子进程注入）", () => {
  const prevEnv = process.env.WAO_TARGET_CWD;
  try {
    process.env.WAO_TARGET_CWD = "/tmp/worker-target-project";
    const cwd = resolveTargetCwd({});
    assert.equal(cwd, resolve("/tmp/worker-target-project"),
      "无 --cwd 时必须回落到 WAO_TARGET_CWD——worker 调 wao 命令自动写进干活的项目");
  } finally {
    if (prevEnv === undefined) delete process.env.WAO_TARGET_CWD;
    else process.env.WAO_TARGET_CWD = prevEnv;
  }
});

test("TD-84: resolveTargetCwd 无 --cwd 无 env 时回落 process.cwd()（向后兼容）", () => {
  const prevEnv = process.env.WAO_TARGET_CWD;
  try {
    delete process.env.WAO_TARGET_CWD;
    const cwd = resolveTargetCwd({});
    assert.equal(cwd, resolve(process.cwd()),
      "无 --cwd 无 env 时回落 process.cwd()——Lead 裸跑 / 本地单项目场景向后兼容");
  } finally {
    if (prevEnv !== undefined) process.env.WAO_TARGET_CWD = prevEnv;
  }
});

test("loadPrompt: --prompt-file 优先，多行内容完整读取（防 PowerShell 截断）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pf-"));
  try {
    const file = join(dir, "task.txt");
    const multiLine = "Line 1: 任务\nLine 2: 多行\nLine 3: 完整";
    writeFileSync(file, multiLine, "utf8");
    const prompt = await loadPrompt({ promptFile: file });
    assert.equal(prompt, multiLine, "多行内容必须完整传递，不得被截断");
  } finally {
    rmrfRetry(dir);
  }
});

test("loadPrompt: 无 promptFile 时回退到 --prompt", async () => {
  const prompt = await loadPrompt({ prompt: "inline task" });
  assert.equal(prompt, "inline task");
});

test("loadPrompt: 既无 promptFile 也无 prompt 时报错", async () => {
  await assert.rejects(() => loadPrompt({}), /--prompt or --prompt-file/);
});

// ---------------------------------------------------------------------------
// worker 失败通知（事故修复 2026-06-17）
//
// waitForCompletion 在 done(failed) 时 throw。旧 CLI 不 catch → 主控看到的是
// CLI exit 1 无输出（没有 runId/error），无法决定是否接手。
// runAndWait 必须捕获 throw，转为 {failed:true, error, runId} 结构化结果。
// ---------------------------------------------------------------------------

test("runAndWait: worker failed 时返回结构化失败结果（不 throw，含 runId + error）", async () => {
  // mock run：waitForCompletion 模拟 done(failed) 抛错
  const fakeRun = {
    transcript: { context: { runId: "run_fail_test_123" } },
    waitForCompletion: async () => { throw new Error("provider error [401]: 身份验证失败"); },
  };
  const result = await runAndWait(fakeRun, {});
  assert.equal(result.runId, "run_fail_test_123", "失败结果必须含 runId（主控要靠它定位 run）");
  assert.equal(result.failed, true, "失败时 failed 必须 true");
  assert.equal(result.completed, false);
  assert.equal(result.timedOut, false);
  assert.match(result.error, /401|身份验证/, "失败结果必须含 error 详情（主控靠它决定是否接手）");
});

test("runAndWait: worker completed 时正常透传结果", async () => {
  const fakeRun = {
    transcript: { context: { runId: "run_ok_test_456" } },
    waitForCompletion: async () => ({ completed: true, messages: [], evidence: [], timedOut: false, metrics: {} }),
  };
  const result = await runAndWait(fakeRun, {});
  assert.equal(result.runId, "run_ok_test_456");
  assert.equal(result.completed, true);
  assert.equal(result.failed, undefined);
});

test("TD-95 #6: failed run 的 error 截断到 ≤500 字符 + 含 diagnosis 字段", async () => {
  // 复盘 #6：error 字段含后端 raw stderr（最多 4000 字符），噪声高不可读。
  // 修复：error 截断到 500 字符 + 附 transcript path；failed 时注入 diagnosis 字段。
  const longError = "x".repeat(3000);
  const fakeRun = {
    transcript: { context: { runId: "run_noise_test_789" }, filePath: "nonexistent-for-diagnosis.jsonl" },
    waitForCompletion: async () => { throw new Error(longError); },
  };
  const result = await runAndWait(fakeRun, {});
  assert.equal(result.failed, true);
  // error 应截断
  assert.ok((result.error?.length ?? 9999) <= 500, `error 应 ≤500 字符，实际 ${result.error?.length}`);
  // diagnosis 字段应存在（即使 transcript 不存在，diagnoseFailure 也不应崩）
  assert.ok(result.diagnosis, "failed run 应含 diagnosis 字段（帮 Lead 快速分类，不用读 raw error）");
  assert.ok(result.transcript, "failed run 应附 transcript path（Lead 需要时能找到完整记录）");
});

test("runAndWait: worker timed_out 时透传（不误判 failed）", async () => {
  const fakeRun = {
    transcript: { context: { runId: "run_to_test_789" } },
    waitForCompletion: async () => ({ completed: false, messages: [], evidence: [], timedOut: true, metrics: {} }),
  };
  const result = await runAndWait(fakeRun, {});
  assert.equal(result.runId, "run_to_test_789");
  assert.equal(result.timedOut, true);
  assert.equal(result.failed, undefined, "超时不应被误判为 failed");
});

// ---------------------------------------------------------------------------
// M8-2：实时仪表盘 buildDashboard（纯聚合函数，不碰 FS）
//
// 设计：buildDashboard(runs) 接收 [{runId, events}, ...]，输出单一视图：
//   { rows: [{runId, agentId, state, tokens:{input,output}, costUsd, evidence, ageMs, flagged}],
//     summary: {total, byState, totalCost, running, flagged} }
// flagged（异常标红）：failed / timed_out / completed 但 scorecard.warn 无证据（M8-1 联动）。
// 这是 🟢 工具域：只读聚合，绝不 retry/stop/改状态。
// ---------------------------------------------------------------------------

test("M8-2: buildDashboard 聚合每个 run 的 runId/agent/state/tokens/cost", () => {
  const runs = [
    {
      runId: "run_a",
      events: [
        { type: "run.submitted", agentId: "coder_hq", ts: "2026-06-26T10:00:00.000Z" },
        { type: "run.state_change", to: "completed", ts: "2026-06-26T10:02:00.000Z" },
        { type: "run.metrics", tokens: { input: 5000, output: 120 }, costUsd: 0.06, ts: "2026-06-26T10:02:00.000Z" },
        { type: "scorecard.checked", passed: true, checks: [], ts: "2026-06-26T10:02:00.000Z" },
      ],
    },
  ];
  const dash = buildDashboard(runs);
  assert.equal(dash.rows.length, 1);
  const row = dash.rows[0];
  assert.equal(row.runId, "run_a");
  assert.equal(row.agentId, "coder_hq");
  assert.equal(row.state, "completed");
  assert.equal(row.tokens.input, 5000);
  assert.equal(row.costUsd, 0.06);
});

test("M8-2: 无证据的 completed run（warn）被标红 flagged（与 M8-1 联动）", () => {
  const runs = [
    {
      runId: "run_warn",
      events: [
        { type: "run.submitted", agentId: "researcher", ts: "2026-06-26T10:00:00.000Z" },
        { type: "run.state_change", to: "completed", ts: "2026-06-26T10:05:00.000Z" },
        { type: "scorecard.checked", passed: false, checks: [{ name: "hasEvidence", passed: false }], ts: "2026-06-26T10:05:00.000Z" },
        { type: "scorecard.warn", detail: "no evidence", ts: "2026-06-26T10:05:00.000Z" },
      ],
    },
  ];
  const dash = buildDashboard(runs);
  assert.equal(dash.rows[0].flagged, true, "completed + warn 无证据 → 应标红");
  assert.equal(dash.summary.flagged, 1);
});

test("M8-2: failed / timed_out run 被标红 flagged", () => {
  const runs = [
    {
      runId: "run_failed",
      events: [
        { type: "run.submitted", agentId: "coder_low", ts: "2026-06-26T10:00:00.000Z" },
        { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-26T10:01:00.000Z" },
      ],
    },
    {
      runId: "run_timeout",
      events: [
        { type: "run.submitted", agentId: "coder_low", ts: "2026-06-26T10:00:00.000Z" },
        { type: "run.timed_out", ts: "2026-06-26T10:02:00.000Z" },
      ],
    },
  ];
  const dash = buildDashboard(runs);
  assert.equal(dash.rows[0].flagged, true, "failed → 标红");
  assert.equal(dash.rows[1].flagged, true, "timed_out → 标红");
  assert.equal(dash.summary.flagged, 2);
});

test("M8-2: summary 聚合 total/byState/totalCost/running", () => {
  const runs = [
    {
      runId: "r1",
      events: [
        { type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" },
        { type: "run.state_change", to: "completed", ts: "2026-06-26T10:01:00.000Z" },
        { type: "run.metrics", tokens: { input: 100 }, costUsd: 0.01, ts: "2026-06-26T10:01:00.000Z" },
      ],
    },
    {
      runId: "r2",
      events: [
        { type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" },
        { type: "run.state_change", to: "running", ts: "2026-06-26T10:00:30.000Z" },
      ],
    },
    {
      runId: "r3",
      events: [
        { type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" },
        { type: "run.state_change", to: "failed", ts: "2026-06-26T10:00:45.000Z" },
        { type: "run.metrics", tokens: { input: 50 }, costUsd: 0.02, ts: "2026-06-26T10:00:45.000Z" },
      ],
    },
  ];
  const dash = buildDashboard(runs);
  assert.equal(dash.summary.total, 3);
  assert.equal(dash.summary.byState.completed, 1);
  assert.equal(dash.summary.byState.running, 1);
  assert.equal(dash.summary.byState.failed, 1);
  assert.equal(dash.summary.running, 1, "running 计数");
  assert.equal(dash.summary.totalCost, 0.03, "成本聚合（只计有 costUsd 的 run）");
});

test("M8-2: 空目录（无 run）不崩，返回空结构", () => {
  const dash = buildDashboard([]);
  assert.deepEqual(dash.rows, []);
  assert.equal(dash.summary.total, 0);
  assert.equal(dash.summary.flagged, 0);
});

test("TD-82: buildDashboard 第二参数 selfDeclared 注入 summary（曝光 Lead 自做）", () => {
  // 不传 selfDeclared → 默认 count:0（不阻塞现有 dashboard 调用方）
  const dash1 = buildDashboard([]);
  assert.deepEqual(dash1.summary.selfDeclared, { count: 0, byReason: {} },
    "不传 selfDeclared 时默认 count:0");
  // 传 selfDeclared → 注入 summary
  const dash2 = buildDashboard([], { count: 3, byReason: { "too-small": 2, "too-coupled": 1 } });
  assert.equal(dash2.summary.selfDeclared.count, 3, "selfDeclared.count 注入");
  assert.equal(dash2.summary.selfDeclared.byReason["too-small"], 2, "byReason 注入");
});

test("M8-2: runsDashboardCommand 渲染 text 输出（含 header + rows + summary，异常标 ⚠）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-"));
  try {
    // run_a：completed + 有证据 + 有 cost
    writeFileSync(join(dir, "run_a.jsonl"), JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-06-26T10:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "completed", ts: "2026-06-26T10:02:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.metrics", tokens: { input: 5000, output: 120 }, costUsd: 0.06, ts: "2026-06-26T10:02:00.000Z" }) + "\n" +
      JSON.stringify({ type: "scorecard.checked", passed: true, checks: [], ts: "2026-06-26T10:02:00.000Z" }) + "\n");
    // run_b：completed + 无证据(warn) → 应标 ⚠
    writeFileSync(join(dir, "run_b.jsonl"), JSON.stringify({ type: "run.submitted", agentId: "researcher", ts: "2026-06-26T10:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "completed", ts: "2026-06-26T10:05:00.000Z" }) + "\n" +
      JSON.stringify({ type: "scorecard.checked", passed: false, checks: [{ name: "hasEvidence", passed: false }], ts: "2026-06-26T10:05:00.000Z" }) + "\n" +
      JSON.stringify({ type: "scorecard.warn", detail: "no evidence", ts: "2026-06-26T10:05:00.000Z" }) + "\n");

    const out = await captureLog(async () => {
      // R23-D 隔离：dashboard 的 selfDeclared/stageProgress 潜伏读
      // resolveTargetCwd() 回退 process.cwd() → 主仓 .wao/pipeline/；
      // 显式 --cwd 钉进 temp 目录（.wao 未 init → 静默 count:0）。
      await runsDashboardCommand(["--run-dir", dir, "--cwd", dir], { runDir: dir });
    });
    assert.match(out, /RUN_ID/, "应有表头");
    assert.match(out, /run_a/, "应列 run_a");
    assert.match(out, /run_b/, "应列 run_b");
    assert.match(out, /\[summary\] total=2/, "应有 summary 聚合行");
    // run_b 标 ⚠（warn 无证据）
    const lines = out.split("\n");
    const runBLine = lines.find((l) => l.includes("run_b"));
    assert.ok(runBLine, "run_b 行存在");
    assert.match(runBLine, /⚠/, "run_b（warn 无证据）应标 ⚠");
  } finally {
    rmrfRetry(dir);
  }
});

test("M8-2: runsDashboardCommand --format json 输出机器可读结构", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-json-"));
  try {
    writeFileSync(join(dir, "run_x.jsonl"), JSON.stringify({ type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "completed", ts: "2026-06-26T10:01:00.000Z" }) + "\n");
    const out = await captureLog(async () => {
      // R23-D 隔离：同 text 用例——--cwd 钉进 temp，隔离 .wao/pipeline/ 潜伏读。
      await runsDashboardCommand(["--run-dir", dir, "--cwd", dir, "--format", "json"], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.summary.total, 1);
    assert.equal(parsed.rows[0].runId, "run_x");
  } finally {
    rmrfRetry(dir);
  }
});

test("WF-9: runsDashboardCommand 长 runId 不得撑乱列对齐", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-align-"));
  try {
    const longRunId = "run_202606260102030000abcdef";
    const shortRunId = "run_short";
    writeFileSync(join(dir, `${longRunId}.jsonl`),
      JSON.stringify({ type: "run.submitted", agentId: "agent_long", ts: "2026-06-26T10:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "completed", ts: "2026-06-26T10:01:00.000Z" }) + "\n");
    writeFileSync(join(dir, `${shortRunId}.jsonl`),
      JSON.stringify({ type: "run.submitted", agentId: "agent_short", ts: "2026-06-26T10:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "running", ts: "2026-06-26T10:01:00.000Z" }) + "\n");

    const out = await captureLog(async () => {
      // R23-D 隔离：dashboard 的 selfDeclared/stageProgress 潜伏读
      // resolveTargetCwd() 回退 process.cwd() → 主仓 .wao/pipeline/；
      // 显式 --cwd 钉进 temp 目录（.wao 未 init → 静默 count:0）。
      await runsDashboardCommand(["--run-dir", dir, "--cwd", dir], { runDir: dir });
    });
    const lines = out.split("\n");
    const header = lines.find((l) => l.startsWith("RUN_ID"));
    const longLine = lines.find((l) => l.startsWith(longRunId));
    const shortLine = lines.find((l) => l.startsWith(shortRunId));
    assert.ok(header);
    assert.ok(longLine);
    assert.ok(shortLine);
    const agentIndex = header.indexOf("AGENT");
    const stateIndex = header.indexOf("STATE");
    assert.equal(longLine.indexOf("agent_long"), agentIndex, "长 runId 行 AGENT 列必须与 header 对齐");
    assert.equal(shortLine.indexOf("agent_short"), agentIndex, "短 runId 行 AGENT 列必须与 header 对齐");
    assert.equal(longLine.indexOf("completed"), stateIndex, "长 runId 行 STATE 列必须与 header 对齐");
    assert.equal(shortLine.indexOf("running"), stateIndex, "短 runId 行 STATE 列必须与 header 对齐");
  } finally {
    rmrfRetry(dir);
  }
});

test("M8-2: runsDashboardCommand 空目录输出 'No runs found.'（不崩）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-empty-"));
  try {
    const out = await captureLog(async () => {
      // R23-D 隔离：dashboard 的 selfDeclared/stageProgress 潜伏读
      // resolveTargetCwd() 回退 process.cwd() → 主仓 .wao/pipeline/；
      // 显式 --cwd 钉进 temp 目录（.wao 未 init → 静默 count:0）。
      await runsDashboardCommand(["--run-dir", dir, "--cwd", dir], { runDir: dir });
    });
    assert.match(out, /No runs found/);
  } finally {
    rmrfRetry(dir);
  }
});

test("P1-1: 启用 requireCertified 时，派发未认证 worker 被拒绝（认证新鲜度强制门）", () => {
  // 06-18 事故头号教训：调度安全不能建立在模型行为假设上。
  // 门（opt-in）：启用 requireCertified 时，目标 worker 必须在新鲜 reliability-summary 里
  // 且 status=certified，否则拒绝派发，给出"先跑 npm run reliability"指引。
  const dir = mkdtempSync(join(tmpdir(), "wao-cert-gate-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        // 一个"已认证"（在 summary 里），一个"未认证"（不在）
        // binary 用不存在的路径：让认证门放行后 backend.spawn 快速失败（而非挂起真 claude）
        // model 用裸 id：claude-code 的 validateAgentPolicy 拒绝 model.providerID
        // （配了即拒，策略校验先于认证门）。
        certified_worker: {
          backend: "claude-code", binary: "/nonexistent/binary", cwd: dir,
          model: { id: "deepseek-v4-flash" },
        },
        unverified_worker: {
          backend: "claude-code", binary: "/nonexistent/binary", cwd: dir,
          model: { id: "glm-5.2" },
        },
      },
    }), "utf8");
    // 造一份新鲜 reliability-summary：只含 certified_worker
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      counts: { certified: 1, conditional: 0, draftOnly: 0, blocked: 0, rejected: 0 },
      allCertified: true,
      workers: {
        certified_worker: { agentId: "certified_worker", backend: "claude-code", providerID: "deepseek", modelId: "deepseek-v4-flash", status: "certified", recommendedUse: "strict-dispatch", lastHealthyRunAt: new Date().toISOString(), capabilities: {}, cases: [] },
      },
    }), "utf8");

    // 派发未认证 worker → 应被拒绝
    const r1 = spawnSync(process.execPath, [
      "src/cli.js", "run", "unverified_worker", "--prompt", "x",
      "--registry", registryPath, "--run-dir", runDir,
      "--require-certified",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    const out1 = (r1.stdout || "") + (r1.stderr || "");
    assert.match(out1, /not certified|未认证|requireCertified|reliability/i,
      "未认证 worker 应被拒绝，错误信息应提示认证");

    // 派发已认证 worker → 不应被认证门拒绝（可能因无真实 backend 失败，但不是 certification-gate 拒绝）
    const r2 = spawnSync(process.execPath, [
      "src/cli.js", "run", "certified_worker", "--prompt", "x",
      "--registry", registryPath, "--run-dir", runDir,
      "--require-certified",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
    const out2 = (r2.stdout || "") + (r2.stderr || "");
    assert.ok(!/not certified|certification-gate|Refused dispatch/i.test(out2),
      "已认证 worker 不应被认证门拒绝（可能因其它原因失败，但不得是 certification-gate）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-1 阈值：core 全过即放行（conditional 放行，draft-only/rejected 拒绝）", () => {
  // owner 决策：门放行线 = core 全过（certified/conditional 都 core 过 → 放行）。
  // strict 是能力画像不是安全闸；draft-only（core 部分过）/rejected（core 失败）才拒。
  // 这避免把"core 全过但不会跑命令"的只读/受限 worker 过度拒绝。
  const dir = mkdtempSync(join(tmpdir(), "wao-cert-threshold-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        // model 用裸 id：claude-code 拒绝 model.providerID，
        // 策略校验先于认证门——带 providerID 会让 draft/reject 的拒绝先撞在策略上。
        cert_w:   { backend: "claude-code", binary: "/nonexistent/binary", cwd: dir, model: { id: "y" } },
        cond_w:   { backend: "claude-code", binary: "/nonexistent/binary", cwd: dir, model: { id: "y" } },
        draft_w:  { backend: "claude-code", binary: "/nonexistent/binary", cwd: dir, model: { id: "y" } },
        reject_w: { backend: "claude-code", binary: "/nonexistent/binary", cwd: dir, model: { id: "y" } },
      },
    }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      version: 1, generatedAt: new Date().toISOString(),
      counts: { certified: 1, conditional: 1, draftOnly: 1, blocked: 0, rejected: 1 },
      workers: {
        // TD-132: 门的新鲜度按 per-worker lastHealthyRunAt 判——放行的两条记录带新鲜时间戳。
        cert_w:   { agentId: "cert_w", status: "certified", recommendedUse: "strict-dispatch", lastHealthyRunAt: new Date().toISOString(), capabilities: {}, cases: [] },
        cond_w:   { agentId: "cond_w", status: "conditional", recommendedUse: "supervised-dispatch", lastHealthyRunAt: new Date().toISOString(), capabilities: {}, cases: [] },
        draft_w:  { agentId: "draft_w", status: "draft-only", recommendedUse: "draft-only", capabilities: {}, cases: [] },
        reject_w: { agentId: "reject_w", status: "rejected", recommendedUse: "do-not-dispatch", capabilities: {}, cases: [] },
      },
    }), "utf8");

    function tryDispatch(agentId) {
      const r = spawnSync(process.execPath, [
        "src/cli.js", "run", agentId, "--prompt", "x",
        "--registry", registryPath, "--run-dir", runDir, "--require-certified",
      ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
      return (r.stdout || "") + (r.stderr || "");
    }

    // certified + conditional 都应放行（不被 certification-gate 拒）
    assert.ok(!/certification-gate|Refused dispatch/i.test(tryDispatch("cert_w")), "certified 应放行");
    assert.ok(!/certification-gate|Refused dispatch/i.test(tryDispatch("cond_w")), "conditional（core 全过）应放行");
    // draft-only + rejected 应被拒
    assert.match(tryDispatch("draft_w"), /certification-gate|Refused dispatch/i, "draft-only 应被拒");
    assert.match(tryDispatch("reject_w"), /certification-gate|Refused dispatch/i, "rejected 应被拒");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-1 manualOverride=cleared：rejected worker 被 owner 背书后放行（绕过 status）", () => {
  // auditor 场景：opus 认证时 rate-limited → status=rejected，但 owner 确认平时可用、不用重测。
  // manualOverride:"cleared" = owner 手动背书，门见到就放行（不造假改 status，有审计痕迹）。
  const dir = mkdtempSync(join(tmpdir(), "wao-cert-override-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        cleared_w: { backend: "claude-code", binary: "/nonexistent/binary", cwd: dir, model: { id: "y" } },
      },
    }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      version: 1, generatedAt: new Date().toISOString(),
      counts: { certified: 0, conditional: 0, draftOnly: 0, blocked: 0, rejected: 1 },
      workers: {
        // status=rejected 但 manualOverride=cleared
        cleared_w: { agentId: "cleared_w", status: "rejected", manualOverride: "cleared", recommendedUse: "owner-cleared", capabilities: {}, cases: [] },
      },
    }), "utf8");

    const r = spawnSync(process.execPath, [
      "src/cli.js", "run", "cleared_w", "--prompt", "x",
      "--registry", registryPath, "--run-dir", runDir, "--require-certified",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    const out = (r.stdout || "") + (r.stderr || "");
    assert.ok(!/certification-gate|Refused dispatch/i.test(out),
      "manualOverride=cleared 的 rejected worker 应被放行（owner 背书绕过 status）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TD-107: wao doctor 的 verdict 会被与本组测试无关的环境检查污染——required
// credential 名（KIMI_WEB_TOKEN/KIMI_API_KEY，本机密钥，干净检出里没有）与本机
// gitignored config/agents.json（registry_loads）。这几个测试只验证 wao_init /
// parse_smoke / invocation_method 本身，不应耦合本机密钥/配置。注入 dummy key +
// 指向 tracked synthetic registry（test/fixtures/agents.six.json），把 verdict
// 隔离到被测检查项。不改产品语义——doctor 仍是 preflight 体检；只是测试不再
// 要求真实密钥/本机配置。R5-B scoped 后防护意图不变：dummy key 让 scoped key
// 检查在进程 env 命中，不触发 Windows User 作用域读取（慢且耦合本机注册表）。
const DOCTOR_REGISTRY = "test/fixtures/agents.six.json";

test("wao doctor: never-inited 目录的 wao_init 不应让 preflight FAIL（fresh-agent 第一步语义）", () => {
  // fresh-agent 把 doctor 当 preflight 第一道（onboarding §4d），"未 init" 是 init 之前的
  // 正常初态，不该和 401/key 缺/CLI 缺（真不健康）同列。降级为 WARN：exit 0、verdict 不含 ISSUE。
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-noinit-"));
  try {
    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--cwd", dir,
      "--registry", DOCTOR_REGISTRY,
      "--format", "json",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: doctorSpawnEnv(),
      timeout: 10000,
    });
    const parsed = JSON.parse(result.stdout);
    const waoInit = parsed.checks.find((c) => c.name === "wao_init");
    assert.ok(waoInit, "doctor 应有 wao_init 检查项");
    // 未初始化 = WARN，不计入 failed → exit 0（preflight 不因"还没 init"判失败）
    assert.equal(waoInit.pass, true, "未初始化的 wao_init 不应 FAIL（fresh-agent preflight 第一步语义）");
    assert.equal(waoInit.level, "warn");
    assert.match(waoInit.detail, /npm run cli -- wao init --cwd/, "WARN 应附 run: 修复提示");
    assert.equal(result.status, 0, "never-inited 目录 doctor 应 exit 0（未 init 是正常初态，非不健康）");
    assert.match(parsed.verdict, /DEGRADED|HEALTHY/);
    assert.ok(!/ISSUE|BROKEN/.test(parsed.verdict), "未 init 不应让 verdict 出现 ISSUE/BROKEN");
    assert.match(parsed.verdict, /（advisory，非门禁）/, "verdict 行应带非门禁标注");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wao doctor: 结构异常的 .wao/ 仍 FAIL（回归保护——结构坏是真不健康）", () => {
  // .wao/ 存在但缺槽位/有多余文件 = 结构损坏，这才是真不健康，应 FAIL。
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-corrupt-"));
  try {
    mkdirSync(join(dir, ".wao"), { recursive: true });
    writeFileSync(join(dir, ".wao", "stray-file.md"), "junk"); // unexpected，无任何合法槽位

    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--cwd", dir,
      "--format", "json",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      timeout: 10000,
    });
    const parsed = JSON.parse(result.stdout);
    const waoInit = parsed.checks.find((c) => c.name === "wao_init");
    assert.ok(waoInit);
    assert.equal(waoInit.pass, false, "结构异常的 .wao/ 必须 FAIL（与未初始化 WARN 区分）");
    assert.notEqual(result.status, 0, "结构损坏应 exit 非零");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-95 #1: doctor 对多余 .wao/ 目录给迁移建议（不只报异常）", () => {
  // 复盘 #1：目标项目有历史 .wao/prompts .wao/scorecards（旧版本遗留），doctor 只报
  // '多余'但不给迁移建议，Lead 不知道能不能删。修复：多余目录时给建议文本。
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-migrate-"));
  try {
    mkdirSync(join(dir, ".wao"), { recursive: true });
    mkdirSync(join(dir, ".wao", "prompts"), { recursive: true });
    writeFileSync(join(dir, ".wao", "prompts", "old.txt"), "legacy");

    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--cwd", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 10000 });
    const parsed = JSON.parse(result.stdout);
    const waoInit = parsed.checks.find((c) => c.name === "wao_init");
    assert.ok(waoInit);
    assert.equal(waoInit.pass, false, "多余目录仍 FAIL（结构异常是真的）");
    // 应含迁移建议（不只报 '多余'，还要告诉 Lead 怎么处理）
    assert.match(waoInit.detail, /迁移|migrate|legacy/i,
      "多余目录时应给迁移建议（不只报异常）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-95 #11: doctor --strict 跑 JS parse smoke（防注释崩溃漏到运行时）", () => {
  // 复盘 #11：doctor 没发现 frictionLog.js 注释崩溃（直到 declare/run 才爆）。
  // --strict 应跑 parse smoke，覆盖 CLI 依赖模块。
  //
  // M11-3D pre sync：full-suite 高并发下 doctor --strict 的 parse_smoke 可能
  // 超过原来的 30s spawnSync timeout，进程被测试 harness 杀死，stdout 不完整或
  // 为空。直接 JSON.parse(result.stdout) 会抛出误导性的 "JSON parse failure"，
  // 掩盖真正原因（ETIMEDOUT / signal / 非 0 退出）。parse_smoke 本身没有声明 30s
  // 产品 SLA，因此把 harness 等待上限调整为 120s，并在 JSON.parse 前精确断言
  // 子进程真实完成——空 stdout 或 timeout 绝不当作成功。
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-strict-"));
  try {
    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--cwd", dir,
      "--registry", DOCTOR_REGISTRY,
      "--strict",
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: doctorSpawnEnv(), timeout: 120000 });

    // Step 1: 子进程必须在测试 harness 杀死它之前自然结束。
    // timeout=true 表示 spawnSync 主动杀进程；绝不可当作"完成"。
    assert.equal(result.signal, null,
      `doctor --strict 子进程不应被 signal 杀死 (got signal=${result.signal})`);
    assert.ok(!result.error,
      `doctor --strict 子进程不应有 spawn 错误 (got error=${JSON.stringify(result.error)})`);
    assert.equal(result.status, 0,
      `doctor --strict 应正常退出 status=0 (got status=${result.status})`);

    // Step 2: 只有自然结束 + status=0，才允许检查 stdout。
    assert.ok(result.stdout && result.stdout.length > 0,
      "doctor --strict 应产出非空 stdout（空 stdout 不可当作合法 JSON）");

    // Step 3: 现在才是合法的 JSON 解析。
    const parsed = JSON.parse(result.stdout);
    const parseCheck = parsed.checks.find((c) => c.name === "parse_smoke");
    assert.ok(parseCheck, "doctor --strict 应有 parse_smoke 检查项");
    assert.equal(parseCheck.pass, true, "WAO 自身 src/ 应全部 parse 通过");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-72 延伸/TD-191⑥: doctor 报告 invocation_method（info 级安装权威如实探测，机器无关）", () => {
  // 演化：旧版自述"故意不进 PATH"绝对句；TD-191⑥ 改为如实探测——PATH 上有无
  // 全局 wao、版本漂移、skills 拷贝同步、本检出根。断言按**结构**而非机器状态：
  // 有 shim 报 shim 事实，无 shim 给 npm run cli 指引；两种形态都合法。
  const dir = mkdtempSync(join(tmpdir(), "wao-invok-"));
  try {
    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--cwd", dir,
      "--registry", DOCTOR_REGISTRY,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: doctorSpawnEnv(), timeout: 20000 });
    const parsed = JSON.parse(result.stdout);
    const inv = parsed.checks.find((c) => c.name === "invocation_method");
    assert.ok(inv, "doctor 应有 invocation_method info 项");
    assert.equal(inv.pass, true);
    assert.equal(inv.level, "info", "invocation_method 是 info 级，不是健康检查");
    // 两种机器形态之一（有/无全局 shim），都必须出现：
    assert.match(inv.detail, /npm run cli -- <command>|全局 `wao` 在 PATH/,
      "无 shim 时给 npm run cli 指引；有 shim 时如实报告 PATH 命中");
    // 恒在：本检出根（安装权威候选事实行，机器无关）
    assert.match(inv.detail, /当前检出（安装权威候选之一）/, "必须报告本检出根事实");
    // 恒不在：旧的绝对句已退场
    assert.ok(!inv.detail.includes("故意不进 PATH"), "旧绝对句'故意不进 PATH'不得残留（TD-191⑥）");
    // info 项不影响 verdict（HEALTHY 不因它变 ISSUE）
    assert.equal(result.status, 0, "info 项不应让 doctor exit 非零");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5-B: doctor scoped——registry 无 worker 时 CLI/key 全部 INFO 跳过（HEALTHY + JSON 加性字段）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-empty-reg-"));
  try {
    // 建一个完整 .wao/（6 槽位）使 wao_init 为 OK——verdict 可确定断言 HEALTHY。
    mkdirSync(join(dir, ".wao"), { recursive: true });
    writeFileSync(join(dir, ".wao", "project.md"), "", "utf8");
    for (const slot of ["decisions", "pipeline", "handoff", "runs", "migration"]) { // 6 必需槽位（project.md + 5 目录；0094：state 转可选）
      mkdirSync(join(dir, ".wao", slot), { recursive: true });
    }
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {} }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", registryPath,
      "--cwd", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 10000 });

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.schemaVersion, 1, "JSON 顶层应有 schemaVersion=1");
    assert.equal(parsed.advisory, true, "JSON 顶层应有 advisory=true");
    assert.equal(parsed.verdict, "HEALTHY（advisory，非门禁）", "无 FAIL 无 WARN → HEALTHY + 非门禁标注");
    assert.equal(result.status, 0);
    for (const cli of ["claude", "codex", "dsh", "kimi"]) {
      const c = parsed.checks.find((x) => x.name === `cli_${cli}`);
      assert.ok(c, `应有 cli_${cli} 检查项`);
      assert.equal(c.status, "info", `无 worker 需要 ${cli} → INFO 跳过`);
      assert.equal(c.pass, true, `cli_${cli} 跳过不判 FAIL`);
      assert.match(c.detail, /未配置（跳过）/);
    }
    const keys = parsed.checks.find((x) => x.name === "keys");
    assert.ok(keys && keys.status === "info", "无 provider worker → key 检查 INFO 跳过");
    // 加性字段：status/severity 每个 check 都有；name/pass/detail/level 兼容保留。
    for (const c of parsed.checks) {
      assert.ok(["ok", "warn", "info", "fail"].includes(c.status), `${c.name} 应有合法 status`);
      assert.equal(c.severity, c.status, `${c.name} 的 severity 应与 status 一致`);
      assert.ok("pass" in c && "detail" in c, `${c.name} 保留兼容字段`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5-B: doctor 无法映射的 backend 给 WARN 不静默；--warn-as-error 使任一 WARN exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-unmapped-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { mystery: { backend: "future-backend-xyz", cwd: dir } },
    }), "utf8");

    const base = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", registryPath,
      "--cwd", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 10000 });
    const parsed = JSON.parse(base.stdout);
    const map = parsed.checks.find((c) => c.name === "backend_map_mystery");
    assert.ok(map, "无法映射的 backend 应有 WARN 检查项（不静默）");
    assert.equal(map.pass, true, "映射 WARN 不判 FAIL");
    assert.equal(map.status, "warn");
    assert.equal(map.level, "warn");
    assert.match(map.detail, /future-backend-xyz/);
    assert.ok(map.fix, "WARN 项应带 fix 指引");
    assert.match(parsed.verdict, /^DEGRADED（\d+ warn）/, "仅 WARN → DEGRADED（N warn）");
    assert.ok(parsed.verdict.endsWith("（advisory，非门禁）"), "verdict 行尾应带非门禁标注");
    assert.equal(base.status, 0, "仅 WARN 时 exit 0");

    const asError = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", registryPath,
      "--cwd", dir,
      "--format", "json",
      "--warn-as-error",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 10000 });
    const parsed2 = JSON.parse(asError.stdout);
    assert.match(parsed2.verdict, /（--warn-as-error）/, "verdict 应标注 --warn-as-error");
    assert.equal(asError.status, 1, "--warn-as-error 时任一 WARN → exit 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5-B: doctor scoped key——只查保留 worker 声明的 env 名；缺失给 FAIL + setx 修复提示", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-scoped-key-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_low: {
          backend: "deepseek-acp",
          credentialEnv: "WAO_TEST_NO_SUCH_KEY_R5B",
          cwd: dir,
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", registryPath,
      "--cwd", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 30000 });
    const parsed = JSON.parse(result.stdout);
    const key = parsed.checks.find((c) => c.name === "key_WAO_TEST_NO_SUCH_KEY_R5B");
    assert.ok(key, "应只查 worker 声明的 env 名");
    assert.equal(key.pass, false);
    assert.equal(key.status, "fail");
    assert.match(key.fix, /setx WAO_TEST_NO_SUCH_KEY_R5B/, "key 缺失 fix 应给 setx（User 作用域）提示");
    assert.match(key.detail, /run: setx/, "FAIL 行应附 run: 修复提示");
    // scoped：未声明的 key 不得被检查（不写死名单）
    assert.ok(!parsed.checks.some((c) => c.name === "key_ZHIPU_API_KEY" || c.name === "key_DEEPSEEK_API_KEY"),
      "未声明的凭据 env 不得被检查（scoped 收窄）");
    assert.equal(result.status, 1, "有 FAIL → exit 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5-B: doctor kimi 特例——kimi-code 靠 CLI 登录态，不查任何 kimi API key", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-kimi-key-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_mm: { backend: "kimi-code", cwd: dir },
        coder_hq: {
          backend: "deepseek-acp",
          credentialEnv: "KIMI_API_KEY",
          cwd: dir,
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", registryPath,
      "--cwd", dir,
      "--format", "json",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, KIMI_API_KEY: "fake-kimi-key" },
      timeout: 10000,
    });
    const parsed = JSON.parse(result.stdout);
    const kimiChecks = parsed.checks.filter((c) => c.name === "key_KIMI_API_KEY");
    // R5 审计 P1-2：kimi 登录态特例只作用于 kimi-code worker 自身（envPolicy 零声明）；
    // 其他 worker 声明的 KIMI_API_KEY 是该 worker 真正需要的 env，必须照常检查
    // （进程 env 已注入 fake-kimi-key → OK）。有真实检查在场时不再叠同名 INFO 说明项。
    assert.equal(kimiChecks.length, 1, "声明的 KIMI_API_KEY 恰一条真实检查（无同名 INFO 叠加）");
    assert.equal(kimiChecks[0].pass, true);
    assert.equal(kimiChecks[0].status, "ok", "fake-kimi-key 已注入进程 env → 存在性检查 OK（未被特例吞掉）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5-B: doctor registry 缺位回退——CLI/key INFO + onboarding 提示，不退回全量 FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-no-registry-"));
  try {
    const missingPath = join(dir, "does-not-exist", "agents.json");
    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", missingPath,
      "--cwd", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 10000 });
    const parsed = JSON.parse(result.stdout);
    const reg = parsed.checks.find((c) => c.name === "registry");
    assert.ok(reg, "缺位回退应有 registry INFO 项");
    assert.equal(reg.status, "info");
    assert.match(reg.detail, /onboarding --agent <id> --apply/);
    for (const cli of ["claude", "codex", "dsh", "kimi"]) {
      const c = parsed.checks.find((x) => x.name === `cli_${cli}`);
      assert.ok(c && c.status === "info", "registry 缺失时 CLI 检查全部 INFO");
    }
    const keys = parsed.checks.find((x) => x.name === "keys");
    assert.ok(keys && keys.status === "info", "registry 缺失时 key 检查 INFO 跳过");
    assert.ok(parsed.checks.some((x) => x.name === "node_version"), "node_version 检查保留");
    assert.ok(parsed.checks.some((x) => x.name === "invocation_method"), "invocation_method 检查保留");
    assert.equal(result.status, 0, "registry 缺位 + 无 FAIL → exit 0（wao_init 未 init 是 WARN 非 FAIL）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── R9-C C-3: doctor panel_readiness 行为面（决策 0023；advisory 非门禁）─────────
// C-1.4 静默条件收窄为 three_seat 且含对抗席；其余形态打印 INFO 且不计 DEGRADED、
// 不改退出码（0023 红线）。fixture 目录先 wao init 把 verdict 隔离到被测面
// （wao_init WARN 不混入断言）；HOME/USERPROFILE 指向空目录隔离本机 OAuth 凭据；
// dummy key 沿 TD-107 doctorSpawnEnv。
// CLI 探测沿既有套件假设（claude/kimi/dsh CLI 在 PATH——与本文件其它 doctor 测试一致）。


test("R9-C C-3: doctor 三席齐备且含对抗席 → panel_readiness 静默（无条目）", () => {
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-panel-silent-", {
    coder_hq: { backend: "deepseek-acp", credentialEnv: "DEEPSEEK_API_KEY", model: { id: "glm-5.2" }, cwd: "." },
    coder_mm: { backend: "deepseek-acp", credentialEnv: "KIMI_API_KEY", model: { id: "kimi-k3" }, cwd: "." },
  });
  try {
    const r = doctorPanelRun(dir, registryPath);
    const parsed = JSON.parse(r.stdout);
    assert.ok(!parsed.checks.some((c) => c.name === "panel_readiness"),
      "≥2 可用席位候选且含对抗席（coder_mm）→ 静默全清（无 panel_readiness 条目）");
    assert.equal(parsed.verdict, "HEALTHY（advisory，非门禁）", "静默面 verdict 不被 panel 检查污染");
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R9-C C-3: doctor 两席 → panel_readiness INFO 打印、不计 DEGRADED、exit 0（advisory 红线）", () => {
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-panel-two-", {
    coder_hq: { backend: "deepseek-acp", credentialEnv: "DEEPSEEK_API_KEY", model: { id: "glm-5.2" }, cwd: "." },
    auditor: { backend: "claude-code", model: { id: "claude-opus-5" }, cwd: "." },
  });
  try {
    const r = doctorPanelRun(dir, registryPath);
    const parsed = JSON.parse(r.stdout);
    const panel = parsed.checks.find((c) => c.name === "panel_readiness");
    assert.ok(panel, "恰 1 名可用席位候选 → 必须打印 panel_readiness");
    assert.equal(panel.status, "info", "INFO 级");
    assert.equal(panel.pass, true, "advisory 不产生 FAIL");
    assert.match(panel.detail, /仅 1 名可用（coder_hq）/, "可用副审只点名席位候选");
    assert.match(panel.detail, /登录态未验证（不计入可用）：auditor/, "login_based 席位如实展示");
    assert.match(panel.fix, /补配不同族系的第二副审可同时升级跨族系多样性/, "C-16：fix 提示含多样性升级");
    assert.equal(parsed.verdict, "HEALTHY（advisory，非门禁）",
      "panel_readiness INFO 不计 DEGRADED（0023 advisory 红线）");
    assert.equal(r.status, 0, "INFO 不改退出码");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R9-C C-3: doctor 零可用席位候选 → INFO 跳过提示 + 如实展示行（登录态/探测未知）", () => {
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-panel-none-", {
    auditor: { backend: "claude-code", model: { id: "claude-opus-5" }, cwd: "." },
    coder_mm: { backend: "kimi-code", model: { id: "kimi-code/k3" }, cwd: "." },
    // deepseek-harness 归一化必填 dshConfigPath+credentialEnv（0065 起 doctor
    // panel 行过归一化门——夹具用合法形状）。
    coder_dsh: { backend: "deepseek-harness", model: { id: "deepseek-v4-pro" }, cwd: ".", dshConfigPath: "C:/wao-test/dsh.json", credentialEnv: "DEEPSEEK_API_KEY" },
  });
  try {
    const r = doctorPanelRun(dir, registryPath);
    const parsed = JSON.parse(r.stdout);
    const panel = parsed.checks.find((c) => c.name === "panel_readiness");
    assert.ok(panel, "0 可用席位候选 → 必须打印（跳过登记提示）");
    assert.equal(panel.status, "info");
    assert.match(panel.detail, /0 名可用/, "none 分级措辞");
    assert.match(panel.detail, /no_reviewer_available/, "闭集码列在提示内");
    assert.match(panel.detail, /登录态未验证（不计入可用）：auditor、coder_mm/,
      "login_based 席位如实展示（auditor+coder_mm）");
    // 0065/TD-258：deepseek-harness 无 CLI 映射但声明 credentialEnv → key_only 面
    // （不是探测未知——key 名可解析是如实展示位，两者不同桶）。
    assert.match(panel.detail, /key 名已解析但无 CLI 探测面（未验证令牌\/serve 可达性，不计入可用）：coder_dsh/,
      "C-12：key_only 面如实展示（deepseek-harness 无 CLI 映射+凭据声明）");
    // deepseek-harness 触发 backend_map WARN → verdict DEGRADED，但无 FAIL：
    // WARN/INFO 都不改 advisory 退出码。
    assert.equal(r.status, 0, "WARN/INFO 面不改退出码（无 FAIL）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R9-C C-1.4→0065（假全清防线平移）: 三席全同族 → doctor 不静默，附跨族系补配提示", () => {
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-panel-nofam-", {
    coder_hq: { backend: "deepseek-acp", credentialEnv: "DEEPSEEK_API_KEY", model: { id: "glm-5.2" }, cwd: "." },
    coder_g2: { backend: "deepseek-acp", credentialEnv: "DEEPSEEK_API_KEY", model: { id: "bigmodel-api/GLM-5.3" }, cwd: "." },
  });
  try {
    const r = doctorPanelRun(dir, registryPath);
    const parsed = JSON.parse(r.stdout);
    const panel = parsed.checks.find((c) => c.name === "panel_readiness");
    assert.ok(panel, "≥2 候选但已知族系不足两族 → 必须打印（消除假全清——0065 平移防线）");
    assert.equal(panel.status, "info");
    assert.match(panel.detail, /已知族系不足两族/, "0065 文案：族系多样性主提示");
    assert.match(panel.detail, /coder_hq、coder_g2/, "候选点名");
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("0065 语义翻转钉（R9-C C-1 历史病灶位）: researcher 角色名键照常计入 → 跨族三席静默", () => {
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-panel-researcher-", {
    researcher: { backend: "deepseek-acp", credentialEnv: "DEEPSEEK_API_KEY", model: { id: "deepseek-v4-pro" }, cwd: "." },
    coder_hq: { backend: "deepseek-acp", credentialEnv: "DEEPSEEK_API_KEY", model: { id: "glm-5.2" }, cwd: "." },
  });
  try {
    const r = doctorPanelRun(dir, registryPath);
    const parsed = JSON.parse(r.stdout);
    // 0065：角色维退役——researcher 计入候选；DeepSeek×GLM 跨族 → 三席全清静默。
    // （旧语义：researcher 非席位 → 两席打印；语义翻转在此钉死，防悄悄退回过滤。）
    assert.ok(!parsed.checks.some((c) => c.name === "panel_readiness"),
      "researcher 计入 + 跨族 → 三席静默（0065 多样性口径）");
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R9-C C-16: 单 worker registry → 空转事实为主句直给（先建议后撤回的话术废除）", () => {
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-panel-solo-", {
    coder_hq: { backend: "deepseek-acp", credentialEnv: "DEEPSEEK_API_KEY", model: { id: "glm-5.2" }, cwd: "." },
  });
  try {
    const r = doctorPanelRun(dir, registryPath);
    const parsed = JSON.parse(r.stdout);
    const panel = parsed.checks.find((c) => c.name === "panel_readiness");
    assert.ok(panel);
    assert.match(panel.detail, /registry 仅一名 worker（coder_hq）/, "空转事实为主句");
    assert.match(panel.detail, /两席\/三席建议事实空转/, "空转明说");
    assert.ok(!panel.detail.includes("可先两席"), "不再先给两席建议再撤回");
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R9-C C-3: registry 缺位 → panel_readiness 沿 U1 INFO 跳过模式", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-panel-noreg-"));
  try {
    const r = spawnSync(process.execPath, ["src/cli.js", "wao", "doctor",
      "--registry", join(dir, "nope.json"), "--cwd", dir, "--format", "json"],
      { cwd: process.cwd(), encoding: "utf8",
        env: { ...doctorSpawnEnv(), HOME: dir, USERPROFILE: dir }, timeout: 20000 });
    const parsed = JSON.parse(r.stdout);
    const panel = parsed.checks.find((c) => c.name === "panel_readiness");
    assert.ok(panel, "registry 缺位时 panel_readiness 检查项恒在场（形状稳定）");
    assert.equal(panel.status, "info");
    assert.match(panel.detail, /未配置（跳过）/, "沿 cli_*/keys/cwd 的 U1 INFO 跳过模式");
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("0065: doctor 分级与 seatRole 声明无关——带声明与不带声明同输入同结果（字段惰性钉）", () => {
  // 旧语义：declared 对抗席计入 vs 未声明回退非席位，两输入分级不同。
  // 0065 终局：字段废弃为惰性——同 registry 形状（my_reviewer+coder_hq 双 ready、
  // DeepSeek×GLM 跨族）无论带不带 seatRole 声明都是三席静默。
  const withDeclared = makeDoctorPanelFixture("wao-doctor-panel-declared-", {
    my_reviewer: { backend: "deepseek-acp", credentialEnv: "DEEPSEEK_API_KEY", model: { id: "deepseek-v4-pro" }, cwd: ".", seatRole: "adversarial" },
    coder_hq: { backend: "deepseek-acp", credentialEnv: "KIMI_API_KEY", model: { id: "glm-5.2" }, cwd: ".", seatRole: "implementation" },
  });
  const undecl = makeDoctorPanelFixture("wao-doctor-panel-undeclared-", {
    my_reviewer: { backend: "deepseek-acp", credentialEnv: "DEEPSEEK_API_KEY", model: { id: "deepseek-v4-pro" }, cwd: "." },
    coder_hq: { backend: "deepseek-acp", credentialEnv: "KIMI_API_KEY", model: { id: "glm-5.2" }, cwd: "." },
  });
  try {
    for (const fx of [withDeclared, undecl]) {
      const r = doctorPanelRun(fx.dir, fx.registryPath);
      const parsed = JSON.parse(r.stdout);
      assert.ok(!parsed.checks.some((c) => c.name === "panel_readiness"),
        "双 ready + 跨族 → 三席静默（seatRole 在场与否不影响分级——字段惰性）");
      assert.equal(r.status, 0);
    }
  } finally {
    rmSync(withDeclared.dir, { recursive: true, force: true });
    rmSync(undecl.dir, { recursive: true, force: true });
  }
});

test("R5-B: doctor fresh clone 缺槽位无多余 → wao_init WARN（不 FAIL）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-freshclone-"));
  try {
    // fresh clone 实际命中态：.wao/ 只含 git 跟踪的 decisions/
    mkdirSync(join(dir, ".wao", "decisions"), { recursive: true });
    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", join(dir, "nope.json"),
      "--cwd", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 10000 });
    const parsed = JSON.parse(result.stdout);
    const waoInit = parsed.checks.find((c) => c.name === "wao_init");
    assert.ok(waoInit);
    assert.equal(waoInit.pass, true, "缺槽位无多余不判 FAIL");
    assert.equal(waoInit.status, "warn");
    assert.match(waoInit.detail, /缺少槽位 \[/);
    assert.match(waoInit.detail, /fresh clone 的正常初态/);
    assert.match(waoInit.detail, /npm run cli -- wao init --cwd/);
    assert.ok(waoInit.fix, "WARN 项应带 fix 提示");
    assert.equal(result.status, 0, "fresh clone 缺槽位 exit 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── R8-2: doctor registry cwd 存在性 WARN（R8-C C-7/C-8/C-10 同步）───────────
// 环境类检查的地盘是 doctor（存在性是机器状态，不进 registry validate；
// validate 的范围见 CLI help）。判定语义与 R7 assertExistingDispatchCwd
// 完全一致（同一 runManager SSOT 探针：path.resolve 后 statSync 目录判定）；
// 能力收窄与 R7 两层派发门对称（本地进程式 backend 查，HTTP serve 豁免）。
// R8-C C-8 起健康面唯一条目：cwd === "." 的 worker 出 INFO（静默落点提示，
// 不计 DEGRADED）；其余健康面零条目（budget_* 同款惯例）。
test("R8-2: doctor registry cwd——坏 cwd 给 WARN（DEGRADED，exit 0）+ run: 子句；\".\" 给 INFO 不给 WARN；HTTP backend 零条目", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-cwd-"));
  // kimi-web 车道在 doctor 有自有就绪检查（tokenEnv）——注入进程 env 使该面 OK，
  // 本用例只断言 cwd_* 条目面（opencode 时代该 fixture 无 token 检查面）。
  process.env.R82_KIMI_WEB_TOKEN = "fake-key-r82-doctor-cwd";
  try {
    const badCwd = join(dir, "no-such-project");
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        // 本地进程式 backend + 不存在的 cwd → 应 WARN（R8-2 主面）
        researcher: { backend: "claude-code", cwd: badCwd },
        // "." 解析为发起派发的进程的 cwd（CLI 通道=敲命令时所在目录；MCP
        // run_dispatch 用本次调用的 expectedWorkspaceRoot），恒存在 → 不 WARN；R8-C C-8 起
        // 出一条 INFO 静默落点提示（R8-1 后模板值即 "."）
        coder_low: { backend: "claude-code", cwd: "." },
        // HTTP serve backend：cwd 是远端目录提示，与派发层能力豁免对称
        // （CE-13/RCE-6 钉死的不拒面）→ doctor 不得更严，不产生条目。
        ghost_serve: {
          backend: "kimi-web",
          serveUrl: "http://127.0.0.1:4297",
          model: { id: "kimi-k3" },
          tokenEnv: "R82_KIMI_WEB_TOKEN",
          cwd: badCwd,
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", registryPath,
      "--cwd", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 10000 });
    const parsed = JSON.parse(result.stdout);

    const warn = parsed.checks.find((c) => c.name === "cwd_researcher");
    assert.ok(warn, "坏 cwd 的本地进程式 worker 应有 cwd_researcher 检查项");
    assert.equal(warn.pass, true, "cwd WARN 不判 FAIL（advisory）");
    assert.equal(warn.status, "warn");
    assert.equal(warn.level, "warn");
    assert.equal(warn.severity, "warn", "R5-B 加性契约：severity 与 status 一致");
    assert.ok(warn.detail.includes(resolve(badCwd)),
      `detail 应携带解析后的绝对路径（${resolve(badCwd)}）`);
    assert.match(warn.detail, /dispatch_cwd_not_found/, "detail 应指向派发期 typed 早拒绝的 reason code");
    assert.match(warn.detail, /run: /, "R8-C C-10：WARN detail 应带 run: 修复子句（backend_map_* 同款惯例）");
    assert.ok(warn.fix, "WARN 项应带 fix 提示");
    assert.match(warn.fix, /--cwd/, "fix 应给 --cwd 替代路径");
    assert.match(warn.fix, /cwd 指向已存在目录/, "fix 应给修 registry cwd 的指引");

    // "." worker：INFO 静默落点提示（R8-C C-8）——不 WARN、不计 DEGRADED
    const dotInfo = parsed.checks.find((c) => c.name === "cwd_coder_low");
    assert.ok(dotInfo, "cwd 为 \".\" 的本地进程式 worker 应有 cwd_coder_low INFO 项（C-8）");
    assert.equal(dotInfo.status, "info");
    assert.equal(dotInfo.level, "info");
    assert.equal(dotInfo.pass, true, "INFO 不判 FAIL");
    assert.equal(dotInfo.severity, "info", "severity 与 status 一致（INFO）");
    assert.match(dotInfo.detail, /发起派发的进程的 cwd/, "INFO 应说明 \".\" 的解析语义（C-7 统一文案）");
    assert.match(dotInfo.fix, /--cwd/, "INFO fix 应给 --cwd 用法（C-8）");

    // 条目面收口：坏 cwd → 1 WARN；"." → 1 INFO；HTTP serve → 零条目
    const cwdItems = parsed.checks.filter((c) => c.name.startsWith("cwd_"));
    assert.deepEqual(
      cwdItems.map((c) => `${c.name}:${c.status}`).sort(),
      ["cwd_coder_low:info", "cwd_researcher:warn"],
      "仅本地进程式 worker 出条目：bad cwd=WARN、\".\"=INFO；kimi-web（远端提示）零条目",
    );
    assert.ok(!parsed.checks.some((c) => c.name === "cwd_ghost_serve"),
      "HTTP serve backend 不得出 cwd_* 条目（CE-13/RCE-6 不拒面对称）");

    assert.match(parsed.verdict, /^DEGRADED（\d+ warn）/, "WARN → DEGRADED");
    assert.equal(result.status, 0, "仅 WARN + INFO → exit 0（advisory 非门禁，INFO 不计 DEGRADED）");
  } finally {
    delete process.env.R82_KIMI_WEB_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R8-C C-8/C-10: doctor cwd 检查——sessionReuse worker 的 INFO/WARN 措辞区分实际拒因（WQ 状态面）", () => {
  // WQ-02 状态枚举：本测试钉 doctor cwd_* 检查在 sessionReuse worker 上的两个
  // 信号面。正常面（cwd 存在）= INFO 静默落点提示；缺失面（cwd 不存在）= WARN，
  // 且措辞不得统一声称 dispatch_cwd_not_found——后台族不带 --cwd 时
  // runDispatch.js:374-381 的 hoisted 检查先抛 SessionReuseWorkspaceRequiredError。
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-cwd-reuse-"));
  try {
    const badCwd = join(dir, "no-such-project");
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        // sessionReuse worker + cwd "."（模板常态）→ INFO，措辞区分后台族拒因
        researcher: { backend: "claude-code", cwd: ".", sessionReuse: "lead_workspace" },
        // sessionReuse worker + 坏 cwd → WARN，措辞区分（先 sessionReuse 拒绝）
        auditor: { backend: "claude-code", cwd: badCwd, sessionReuse: "lead_workspace" },
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", registryPath,
      "--cwd", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 10000 });
    const parsed = JSON.parse(result.stdout);

    // 状态 1（正常面）：cwd "." 的 sessionReuse worker → INFO + 拒因预告
    const info = parsed.checks.find((c) => c.name === "cwd_researcher");
    assert.ok(info, "sessionReuse + \".\" 应有 INFO 项");
    assert.equal(info.status, "info");
    assert.match(info.detail, /SessionReuseWorkspaceRequiredError/,
      "sessionReuse worker 的 INFO 应预告后台族不带 --cwd 的实际先发拒绝（不是 cwd 不存在）");
    assert.match(info.detail, /发起派发的进程的 cwd/,
      "同时保留 \".\" 的解析语义（前台 run 不解析 sessionReuse 的落点）");

    // 状态 2（缺失面）：坏 cwd 的 sessionReuse worker → WARN + 措辞区分
    const warn = parsed.checks.find((c) => c.name === "cwd_auditor");
    assert.ok(warn, "sessionReuse + 坏 cwd 应有 WARN 项");
    assert.equal(warn.status, "warn");
    assert.match(warn.detail, /SessionReuseWorkspaceRequiredError/,
      "C-10：sessionReuse worker 的 WARN 不得统一声称 dispatch_cwd_not_found——后台族不带 --cwd 先报 workspace-required");
    assert.match(warn.detail, /dispatch_cwd_not_found/,
      "带 --cwd 的路径仍指向 dispatch_cwd_not_found（两种拒因都在措辞里）");
    assert.match(warn.detail, /run: /, "WARN detail 带 run: 子句");

    // 非适用状态声明：cwd_* 检查无 loading/missing 态（registry 缺位由聚合
    // "cwd" INFO 承担，见 R8-2 registry 缺位测试）；unparseable 由 registry_loads
    // WARN 承担、cwd_* 逐 worker 面整体跳过——不在此重复覆盖。
    assert.equal(result.status, 0, "1 WARN + 1 INFO → exit 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R8-2: doctor registry 缺位 → cwd 检查 INFO 跳过（沿用 R5-B U1 全 INFO 模式，不新增 FAIL 面）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-cwd-noreg-"));
  try {
    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", join(dir, "does-not-exist", "agents.json"),
      "--cwd", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 10000 });
    const parsed = JSON.parse(result.stdout);
    const cwdInfo = parsed.checks.find((c) => c.name === "cwd");
    assert.ok(cwdInfo, "registry 缺位应有聚合 cwd INFO 项（与 keys 同款）");
    assert.equal(cwdInfo.status, "info");
    assert.equal(cwdInfo.pass, true, "INFO 跳过不判 FAIL");
    assert.match(cwdInfo.detail, /未配置（跳过）/);
    assert.deepEqual(parsed.checks.filter((c) => c.name.startsWith("cwd_")), [],
      "无 registry → 不逐 worker 出 cwd_* 条目");
    assert.equal(result.status, 0, "缺位回退 exit 0（wao_init WARN 不计 FAIL）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R8-2: --warn-as-error 在仅 cwd 存在性 WARN 时 exit 1（分级语义回归）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-cwd-wae-"));
  try {
    // 隔离出"恰一条 WARN"：完整 .wao/（wao_init OK）+ 单个 codex worker
    // （无 provider → keys INFO）+ 坏 cwd。
    // R8-C C-11：不再断言精确 verdict 等值（"DEGRADED（1 warn）…"）——它与
    // "codex 在 PATH"强耦合（无 codex 的机器上 cli_codex 变 FAIL → BROKEN，
    // 测试在别的检出上误红）。改为结构性断言：checks 里恰有一条 status==="warn"
    // 且 name 为 cwd_tester，与 cli_* 的 PATH 探测结果解耦。
    mkdirSync(join(dir, ".wao"), { recursive: true });
    writeFileSync(join(dir, ".wao", "project.md"), "", "utf8");
    for (const slot of ["decisions", "pipeline", "handoff", "runs", "migration"]) { // 6 必需槽位（project.md + 5 目录；0094：state 转可选）
      mkdirSync(join(dir, ".wao", slot), { recursive: true });
    }
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { tester: { backend: "codex", cwd: join(dir, "no-such-project") } },
    }), "utf8");

    const base = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", registryPath,
      "--cwd", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: doctorSpawnEnv(), timeout: 10000 });
    const parsedBase = JSON.parse(base.stdout);
    const warnChecks = parsedBase.checks.filter((c) => c.status === "warn");
    assert.deepEqual(warnChecks.map((c) => c.name), ["cwd_tester"],
      `恰一条 WARN 且为 cwd_tester（与 cli_* 的 PATH 探测解耦）；实际 warn: [${warnChecks.map((c) => c.name).join(", ")}]`);
    assert.ok(!parsedBase.checks.some((c) => c.name === "cwd_tester" && c.status !== "warn"),
      "cwd_tester 不得同时出现第二种状态");
    // exit 0 断言仅在零 FAIL 时成立（cli_codex 依赖本机 PATH；有 FAIL 时 exit 1
    // 与 --warn-as-error 无关，不为它制造 PATH 耦合）。
    if (!parsedBase.checks.some((c) => c.status === "fail")) {
      assert.equal(base.status, 0, "仅 WARN（零 FAIL）→ exit 0");
    }

    const asError = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--registry", registryPath,
      "--cwd", dir,
      "--format", "json",
      "--warn-as-error",
    ], { cwd: process.cwd(), encoding: "utf8", env: doctorSpawnEnv(), timeout: 10000 });
    const parsedWae = JSON.parse(asError.stdout);
    assert.match(parsedWae.verdict, /（--warn-as-error）/, "verdict 应标注 --warn-as-error");
    assert.equal(asError.status, 1, "--warn-as-error 时仅此项 WARN → exit 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-75: status 输出心跳字段 lastActivityTs + secondsSinceActivity（有 run.event 的 run）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hb-"));
  try {
    const lastActivityTs = "2026-06-28T18:44:53.000Z"; // 固定过去时间，secondsSinceActivity 应 > 0
    writeFileSync(join(dir, "run_hb.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-06-28T18:40:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "running", ts: "2026-06-28T18:40:01.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "message", role: "assistant", parts: [], ts: "2026-06-28T18:44:51.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "command", command: "ls", ts: lastActivityTs }) + "\n");
    const out = await captureLog(async () => {
      await statusCommand(["run_hb", "--run-dir", dir], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.runId, "run_hb");
    assert.equal(parsed.lastActivityTs, lastActivityTs, "lastActivityTs = 最后一条 run.event 的 ts");
    assert.ok(typeof parsed.secondsSinceActivity === "number" && parsed.secondsSinceActivity > 0,
      "secondsSinceActivity 是正数（距 lastActivityTs 的秒数）");
    // TD-75 补全：lastActivityKind + lastActivitySummary（Lead 据此掌握 worker 在干啥）
    assert.equal(parsed.lastActivityKind, "跑命令", "command → 跑命令");
    assert.match(parsed.lastActivitySummary, /ls/, "summary 应含命令名");
  } finally {
    rmrfRetry(dir);
  }
});

test("M12-17-C1: status 输出 executionStage（无 runId 信封的 legacy 种子仍正确投影）", async () => {
  // 与 TD-75 同形：seed 全部事件没有 runId 信封（legacy transcript 形态）。
  // 投影必须把缺信封的 legacy 行当作 in-scope（不 throw、不跳过），
  // 只在信封 runId 存在且不同时才视为 cross-run 外圈事件。
  const dir = mkdtempSync(join(tmpdir(), "wao-stage-cli-"));
  try {
    // 1) 活跃 run：submitted → running → run.event → active
    writeFileSync(join(dir, "run_stage_a.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-06-28T18:40:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "running", ts: "2026-06-28T18:40:01.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "command", command: "ls", ts: "2026-06-28T18:44:53.000Z" }) + "\n");
    const out = await captureLog(async () => {
      await statusCommand(["run_stage_a", "--run-dir", dir], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.executionStage.phase, "active", "legacy 无信封种子仍投影出 active");
    assert.equal(parsed.executionStage.sinceTs, "2026-06-28T18:44:53.000Z", "sinceTs = 首个 run.event 的 ts");
    assert.ok(typeof parsed.executionStage.secondsSince === "number" && parsed.executionStage.secondsSince > 0,
      "secondsSince 是正数（距 sinceTs 的秒数）");

    // 2) 终态 run：run.error + state_change failed（TD-99 原子配对）→ terminal
    writeFileSync(join(dir, "run_stage_t.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-06-28T18:40:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "message", role: "assistant", parts: [], ts: "2026-06-28T18:44:51.000Z" }) + "\n" +
      JSON.stringify({ type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-06-28T18:45:14.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-28T18:45:14.000Z" }) + "\n");
    const outT = await captureLog(async () => {
      await statusCommand(["run_stage_t", "--run-dir", dir], { runDir: dir });
    });
    const parsedT = JSON.parse(outT);
    assert.equal(parsedT.executionStage.phase, "terminal", "失败终态投影为 terminal");
    assert.equal(parsedT.executionStage.sinceTs, "2026-06-28T18:45:14.000Z", "sinceTs = 首个终态事实的 ts");

    // 3) 冲突终态（completed + failed）→ unknown，绝不替 Lead 选赢家
    writeFileSync(join(dir, "run_stage_c.jsonl"),
      JSON.stringify({ type: "run.state_change", to: "completed", ts: "2026-06-28T18:45:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "failed", reason: "recount", ts: "2026-06-28T18:45:14.000Z" }) + "\n");
    const outC = await captureLog(async () => {
      await statusCommand(["run_stage_c", "--run-dir", dir], { runDir: dir });
    });
    const parsedC = JSON.parse(outC);
    assert.deepEqual(parsedC.executionStage, { phase: "unknown", sinceTs: null, secondsSince: null },
      "冲突终态 → unknown，null 年龄");
  } finally {
    rmrfRetry(dir);
  }
});

// 2026-10-12 消费者侧反馈：末事件是一次文件读取的 tool_result 时，`last` 把整份
// 文件正文回显出来刷满终端。显示层截断超长字符串叶子，结构与合法 JSON 不变。
test("status: last 里的超长字符串被截到有界长度并标出省略量（短字段与结构原样）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-status-last-"));
  try {
    const big = "x".repeat(5000);
    writeFileSync(join(dir, "run_biglast.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-06-28T18:40:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "running", ts: "2026-06-28T18:40:01.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "tool_result", tool: "Read", output: big, nested: { parts: [{ text: big }, { text: "short" }] }, ts: "2026-06-28T18:44:53.000Z" }) + "\n");
    const out = await captureLog(async () => {
      await statusCommand(["run_biglast", "--run-dir", dir], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    assert.ok(out.length < 2500, `整份输出有界（实际 ${out.length} 字符；截断前 >10000）`);
    assert.equal(parsed.last.type, "run.event");
    assert.equal(parsed.last.tool, "Read", "短字段原样");
    assert.match(parsed.last.output, /^x{300}… \[\+4700 chars; full text: tail\/collect\]$/);
    assert.match(parsed.last.nested.parts[0].text, /\[\+4700 chars/, "嵌套叶子同样截断");
    assert.equal(parsed.last.nested.parts[1].text, "short");
    assert.equal(parsed.state, "running", "状态字段不受影响");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-75 补全: lastActivityKind 按事件 kind 映射成 Lead 可读活动类型", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hb-kind-"));
  try {
    // message → "在说话"，tool_use:Read → "在用工具 Read"，file_written → "在写文件"
    writeFileSync(join(dir, "run_hbk.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "a", ts: "2026-06-28T18:40:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "message", role: "assistant", parts: [], ts: "2026-06-28T18:40:01.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "tool_use", tool: "Read", input: { file_path: "x.js" }, ts: "2026-06-28T18:40:02.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "tool_result", tool: "Read", output: "...", ts: "2026-06-28T18:40:03.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "file_written", path: "D:/proj/out.txt", ts: "2026-06-28T18:40:04.000Z" }) + "\n");
    const out = await captureLog(async () => {
      await statusCommand(["run_hbk", "--run-dir", dir], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    // 最后一条是 file_written → kind="在写文件"，summary 含文件名
    assert.equal(parsed.lastActivityKind, "在写文件");
    assert.match(parsed.lastActivitySummary, /out\.txt/, "summary 应含文件名");
    assert.equal(parsed.lastActivityTs, "2026-06-28T18:40:04.000Z");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-113: status 重复同名写活动计数 — 交错不算断，lastActivitySummary = 写 out.txt ×3（最近）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hb-repeat-"));
  try {
    // 真实 parser 形状：file_written 前紧邻 tool_result（transcript 中
    // file_written 永不相邻），计数必须在 file_written 子序列上做。
    writeFileSync(join(dir, "run_hbr.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-06-28T18:40:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "file_written", path: "D:/proj/out.txt", ts: "2026-06-28T18:40:01.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "tool_result", tool: "Write", ts: "2026-06-28T18:40:02.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "file_written", path: "D:/proj/out.txt", ts: "2026-06-28T18:40:03.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "tool_result", tool: "Write", ts: "2026-06-28T18:40:04.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "file_written", path: "D:/proj/out.txt", ts: "2026-06-28T18:40:05.000Z" }) + "\n");
    const out = await captureLog(async () => {
      await statusCommand(["run_hbr", "--run-dir", dir], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.lastActivityKind, "在写文件");
    assert.equal(parsed.lastActivitySummary, "写 out.txt ×3（最近）",
      "末尾同名写入 ×3（长文档/大文件写入期间分清在推进还是卡死）");
    assert.equal(parsed.lastActivityTs, "2026-06-28T18:40:05.000Z");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-75: status 无 run.event 时 lastActivityTs=null（纯启动失败）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hb-empty-"));
  try {
    writeFileSync(join(dir, "run_hb0.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-06-28T18:40:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.error", phase: "spawn", error: "binary not found", ts: "2026-06-28T18:40:01.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "failed", reason: "spawn_error", ts: "2026-06-28T18:40:01.000Z" }) + "\n");
    const out = await captureLog(async () => {
      await statusCommand(["run_hb0", "--run-dir", dir], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.lastActivityTs, null, "无 run.event → lastActivityTs=null");
    assert.equal(parsed.secondsSinceActivity, null, "无 run.event → secondsSinceActivity=null");
    assert.equal(parsed.lastActivityKind, null, "无 run.event → lastActivityKind=null");
    assert.equal(parsed.lastActivitySummary, null, "无 run.event → lastActivitySummary=null");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-75: status 终态 failed run 也输出心跳（Lead 据此判死前是否还活着）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hb-fail-"));
  try {
    const lastActivityTs = "2026-06-28T18:44:53.000Z";
    writeFileSync(join(dir, "run_hbf.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-06-28T18:40:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "message", role: "assistant", parts: [], ts: lastActivityTs }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "command", command: "ls", ts: lastActivityTs }) + "\n" +
      JSON.stringify({ type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-06-28T18:45:14.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-28T18:45:14.000Z" }) + "\n");
    const out = await captureLog(async () => {
      await statusCommand(["run_hbf", "--run-dir", dir], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.state, "failed");
    assert.equal(parsed.lastActivityTs, lastActivityTs, "终态 run 也输出 lastActivityTs（死前最后心跳）");
    assert.ok(typeof parsed.secondsSinceActivity === "number", "终态 run 也输出 secondsSinceActivity");
  } finally {
    rmrfRetry(dir);
  }
});

// ---------------------------------------------------------------------------
// R13（2026-08-18，TD-127）：retry 任务文本取法绑定修复。
// R13-C（同日验收会审返工，auditor P1-1）：删除 R13 的 messageId 优先收窄，
// 回归纯 findLatestBound。复核依据：claudeCode.js:35 / kimiCode.js:24 /
// codex.js:13 全部 extends ProcessBackend，其 spawn 结果 messageId === undefined
// （processBackend.js:340），transcript.append 的 JSON.stringify 丢 undefined 键
// （transcript.js:670）→ 该家族合法 TD-54 双写【两条都无 messageId】——
// "同 runId 无 messageId 伪造被收窄挡下"的宣称对该家族完全不成立（探针 D：
// 裸伪造经 fallback 照样被派发）。旧夹具自称 claude-code 却返回 messageId，
// 恰好掩盖了这个空档（已在 R13-C 修正）。
// 诚实边界（R13-C 统一口径）：绑定杀跨 run 注入与错读；同 runId 追加伪造
// （无论是否带 messageId）属有 runs/ 写权限攻击面，读侧无解，真边界在写入端
// 完整性。D 形状测试钉住当前行为，防悄悄变化。
// 观察手段：retry 派发的 prompt 即新 run transcript 落盘的 prompt.sent.prompt
// （start 在 spawn 前把它原样写入新 run——TD-54 形状，两值恒等）。
// ---------------------------------------------------------------------------

/** 读 retry 派发进新 run 的任务文本（新 run transcript 的 prompt.sent 记录）。 */
async function readRedispatchedPrompt(newTranscriptPath) {
  const events = await readTranscript(newTranscriptPath);
  const prompts = events.filter((e) => e.type === "prompt.sent").map((e) => e.prompt);
  assert.ok(prompts.length >= 1, "新 run 应落盘 prompt.sent");
  // TD-54 双写：两条 prompt 值恒等；取首条即派发文本。
  for (const p of prompts) assert.equal(p, prompts[0], "同一 retry 的双 prompt.sent 值恒等");
  return prompts[0];
}

test("R13-CLI-1: 共享绑定读取器单测 — findLatestBound/findFirstBound（空/无匹配/多条/绑定过滤/首尾分叉）", () => {
  const mine = (seq, extra = {}) => ({ seq, type: "prompt.sent", runId: "run_a", ...extra });
  const foreign = (seq, extra = {}) => ({ seq, type: "prompt.sent", runId: "run_other", ...extra });
  // 空 / 无匹配 → undefined。
  assert.equal(findLatestBound([], "prompt.sent", "run_a"), undefined, "空序列 → undefined");
  assert.equal(findFirstBound([], "prompt.sent", "run_a"), undefined, "空序列 → undefined");
  assert.equal(findLatestBound([foreign(1)], "prompt.sent", "run_a"), undefined, "仅跨 run 事件 → 绑定过滤后无匹配");
  assert.equal(findFirstBound([foreign(1)], "prompt.sent", "run_a"), undefined, "仅跨 run 事件 → 绑定过滤后无匹配");
  assert.equal(findLatestBound([mine(1)], "no.such", "run_a"), undefined, "类型不匹配 → undefined");
  // 多条取末条 / 取首条（末条=合法 TD-54 第二写；首条=R12-C run.started 纪律）。
  const e1 = mine(1, { prompt: "first" });
  const e2 = mine(2, { prompt: "second" });
  const e3 = foreign(3, { prompt: "forged-tail" });
  assert.equal(findLatestBound([e1, e2, e3], "prompt.sent", "run_a"), e2, "多条本 run 取末条，尾部跨 run 伪造不采信");
  assert.equal(findFirstBound([e1, e2, e3], "prompt.sent", "run_a"), e1, "多条本 run 取首条");
  // 首尾分叉：伪造在本 run 事件之前时两读取器仍各按各的序取。
  assert.equal(findLatestBound([e3, e1, e2], "prompt.sent", "run_a"), e2);
  assert.equal(findFirstBound([e3, e1, e2], "prompt.sent", "run_a"), e1);
  // 旧格式（事件无 runId 字段）→ 严格绑定下不匹配（调用方 ?. 链宽容处理）。
  assert.equal(findLatestBound([{ seq: 1, type: "prompt.sent", prompt: "legacy" }], "prompt.sent", "run_a"), undefined,
    "无 runId 信封的旧格式事件不匹配绑定读取");
});

test("R13-CLI-2: 篡改探针（跨 runId）— 尾部伪造 prompt.sent 不被派发，回退真实本 run 记录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r13-xrun-"));
  try {
    // 真实：单条本 run prompt（无 messageId——spawn 前首写形状）。尾部追加跨 runId
    // 伪造（修复前 findLatest 恰好采信这条并派发其文本）。
    writeRetrySource(dir, "run_real", {
      extraEvents: [{
        seq: 3, ts: "2026-08-18T00:00:00.200Z", type: "prompt.sent", runId: "run_other",
        agentId: "claude_worker", prompt: "FORGED cross-run task text", messageId: "m_forged",
      }],
    });
    const { config } = makeRetryInheritFixture(dir);
    const out = await captureLog(() => retryCommand(["run_real", "--run-dir", dir], config));
    const parsed = parseRetryJson(out);
    const dispatched = await readRedispatchedPrompt(parsed.transcript);
    assert.equal(dispatched, "original task prompt", "跨 runId 尾部伪造不采信——派发真实本 run 记录");
  } finally {
    rmrfRetry(dir);
  }
});

test("R13-CLI-3: D 形状探针 — ProcessBackend 盘上真实形状（合法双写均无 messageId）+ 同 runId 裸伪造尾条仍被派发（钉当前已知边界）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r13-srun-"));
  try {
    // (0) 盘上形状钉：经真实 manager.start（诚实夹具，spawn 不返回 messageId）
    //     产生的新 run transcript 里，合法 TD-54 双写两条均无 messageId/
    //     admittedSeq 键（undefined 被 JSON 序列化丢弃）。
    //     R14（TD-129a）诚实化：本断言钉的是【夹具链】形状——夹具是本文件
    //     手写的假 backend，真实 processBackend.js 改动不影响它，所以"后端
    //     家族开始真实返回 messageId"时这里【不会】变红。真实契约哨兵在
    //     test/backends/processBackend.test.js 的 R14-W3（直接断言真实
    //     ProcessBackend 家族 spawn 结果 messageId/admittedSeq === undefined，
    //     后端开始写 messageId 时那条变红）——重新评估本文件 D 形状结论
    //     的触发器在那里，不在本断言。
    writeRetrySource(dir, "run_shape0");
    const { config } = makeRetryInheritFixture(dir);
    let out = await captureLog(() => retryCommand(["run_shape0", "--run-dir", dir], config));
    let parsed = parseRetryJson(out);
    const newEvents = await readTranscript(parsed.transcript);
    const newPrompts = newEvents.filter((e) => e.type === "prompt.sent");
    assert.equal(newPrompts.length, 2, "合法 TD-54 双写（spawn 前首写 + spawn 后补写）");
    for (const e of newPrompts) {
      assert.equal("messageId" in e, false, "ProcessBackend 家族合法写落盘不带 messageId 键");
      assert.equal("admittedSeq" in e, false, "ProcessBackend 家族合法写落盘不带 admittedSeq 键");
    }

    // (a) D 形状篡改探针（钉当前行为）：源 run 用 ProcessBackend 家族的真实
    //     盘上形状——合法双写（两条均裸）+ 尾部同 runId 裸伪造（无 messageId）。
    //     纯 findLatestBound 取末条绑定事件 = 伪造条 → 仍被派发。这是【已知
    //     边界】而非防御宣称：同 runId 追加伪造 = 持有 runs/ 写权限攻击面，
    //     读侧无解（真边界在写入端完整性）。钉住它防两件事：行为悄悄变化、
    //     或"收窄能挡裸伪造"的虚假宣称回潮（R13 的 messageId 收窄在该形状
    //     下就是死代码——合法事件同样无 messageId，优先循环永远落空）。
    writeRetrySource(dir, "run_dshape", {
      extraEvents: [
        { seq: 3, ts: "2026-08-18T00:00:00.150Z", type: "prompt.sent", runId: "run_dshape",
          agentId: "claude_worker", prompt: "original task prompt" },
        { seq: 4, ts: "2026-08-18T00:00:00.200Z", type: "prompt.sent", runId: "run_dshape",
          agentId: "claude_worker", prompt: "FORGED bare same-run tail" },
      ],
    });
    out = await captureLog(() => retryCommand(["run_dshape", "--run-dir", dir], config));
    parsed = parseRetryJson(out);
    let dispatched = await readRedispatchedPrompt(parsed.transcript);
    assert.equal(dispatched, "FORGED bare same-run tail",
      "钉当前已知边界：同 runId 裸伪造尾条仍被派发（末条绑定事件；读侧无解，真边界在写入端）");

    // (b) 对照：形状完整（带 messageId）的同 runId 伪造同样被派发——messageId
    //     有无不改变结局，佐证"收窄已删、绑定语义唯一"。
    writeRetrySource(dir, "run_shape1", {
      extraEvents: [{
        seq: 3, ts: "2026-08-18T00:00:00.200Z", type: "prompt.sent", runId: "run_shape1",
        agentId: "claude_worker", messageId: "m_forged", admittedSeq: 6,
        prompt: "FORGED shape-complete same-run tail",
      }],
    });
    out = await captureLog(() => retryCommand(["run_shape1", "--run-dir", dir], config));
    dispatched = await readRedispatchedPrompt(parseRetryJson(out).transcript);
    assert.equal(dispatched, "FORGED shape-complete same-run tail",
      "同 runId 形状完整伪造同样被派发——与 (a) 同一边界，messageId 有无不改变结局");
  } finally {
    rmrfRetry(dir);
  }
});

test("R13-CLI-4: 合法双条回归 — TD-54 双 prompt.sent（HTTP 家族形状：第二写带 messageId）→ retry 仍取最后一条绑定记录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r13-dbl-"));
  try {
    // runManager.start 的合法形状（HTTP 家族，如 kimi-web）：spawn 前首写
    // {prompt}，spawn 后补写 {messageId, admittedSeq, prompt}（runManager.js
    // 双写位）。两条文本用不同值以分辨取法——断言"取最后一条本 run 绑定记录"
    // 语义在纯绑定（R13-C 删收窄后）原样保留。
    writeRetrySource(dir, "run_dbl", {
      extraEvents: [{
        seq: 3, ts: "2026-08-18T00:00:00.150Z", type: "prompt.sent", runId: "run_dbl",
        agentId: "claude_worker", messageId: "m_real", admittedSeq: 5, prompt: "second-write prompt",
      }],
    });
    const { config, spawned } = makeRetryInheritFixture(dir);
    const out = await captureLog(() => retryCommand(["run_dbl", "--run-dir", dir], config));
    const parsed = parseRetryJson(out);
    const dispatched = await readRedispatchedPrompt(parsed.transcript);
    assert.equal(dispatched, "second-write prompt", "合法双条取第二写（带 messageId）——TD-54 语义不变");
    assert.equal(spawned.length, 1, "正常 retry 全链 spawn 一次");
  } finally {
    rmrfRetry(dir);
  }
});

test("R13-CLI-5: 全部 prompt.sent 均跨 run（无本 run 绑定记录）→ retry 拒绝（fail-closed，零新 transcript）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r13-none-"));
  try {
    // 载体 run 只有 run.started + 一条 FOREIGN runId 的 prompt.sent——绑定纪律下
    // 本 run 无任务文本可派发。修复前无绑定 findLatest 会派发外 run 的文本；
    // 修复后走 "no runId-bound prompt.sent" 拒绝面（R13-C 起文案如实覆盖两情形：
    // 无 prompt 记录 / pre-envelope legacy 不可经绑定读取器重试，并给 `run` 逃生口）。
    const started = {
      seq: 1, ts: "2026-08-18T00:00:00.000Z", type: "run.started", runId: "run_none",
      agentId: "claude_worker", backend: "claude-code", cwd: dir,
      model: { id: "glm-5.3", contextWindow: 1000000 }, reasoning: { effort: "medium" },
    };
    const foreignPrompt = {
      seq: 2, ts: "2026-08-18T00:00:00.100Z", type: "prompt.sent", runId: "run_other",
      agentId: "claude_worker", prompt: "FOREIGN-ONLY task text", messageId: "m_foreign",
    };
    writeFileSync(join(dir, "run_none.jsonl"),
      `${[started, foreignPrompt].map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
    const { config } = makeRetryInheritFixture(dir);
    await assert.rejects(
      () => retryCommand(["run_none", "--run-dir", dir], config),
      (e) => {
        assert.match(e.message, /Run run_none: no runId-bound prompt\.sent found in this transcript/,
          "R13-C 如实文案：无绑定 prompt 记录 + legacy 不可经绑定读取器重试 + `run` 逃生口");
        assert.match(e.message, /re-dispatch explicitly with `run`/, "文案包含逃生口指引");
        return true;
      },
    );
    // 拒绝发生在 manager.start 之前：零新 transcript、零 spawn。
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".jsonl")), ["run_none.jsonl"],
      "fail-closed 先于 start——零新 transcript");
  } finally {
    rmrfRetry(dir);
  }
});
