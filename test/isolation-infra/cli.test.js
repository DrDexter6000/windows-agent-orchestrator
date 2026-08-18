// cli.test.js
//
// 锁定 CLI 参数解析 + prompt 加载 + worker 失败通知的不变量。
// 重点：--prompt-file 必须把多行内容完整传递（PowerShell 多行 --prompt 会被截断）。
// 重点：worker failed 时主控必须收到结构化失败结果（runId/failed/error），不能裸 crash。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseOptions, loadPrompt, runAndWait, buildDashboard, runsDashboardCommand, runCommand, statusCommand, collectCommand, resolveTargetCwd } from "../../src/cli.js";
import { readTranscript, findState, findLatestBound, findFirstBound } from "../../src/transcript.js";
import { spawnCommand } from "../../src/commands/run.js";
// R12: retry 的 per-dispatch 覆盖继承（同形重试）——直接 import 命令实现（lifecycle
// 不是 public export 面，无 re-export 需求；与 spawnCommand 同一 import 纪律）。
import { retryCommand } from "../../src/commands/lifecycle.js";
import { rmrfRetry, sleepSync } from "../_rmrfHelper.mjs";
// Round2-AB（friction 2026-08-15 #1/#2/#3）：COMMAND_NAMES 关系守卫 + run --help 用法页。
import { COMMAND_NAMES, HELP_TEXT } from "../../src/cliHelp.js";

/** 捕获 console.log 输出（用于测命令渲染）。返回拼接的字符串。 */
async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

// 用字面 `node`（PATH 上的 node）执行 `node src/cli.js <cmd>` 并返回 stdout。
// 这些 registry list/validate 行为测试的子进程验证的是 CLI 行为本身，不是
// version guard（guard 的行为由 test/nodeVersionGuard.test.js 专测）。字面
// `node` 常是 PATH 上的 v24，会被 src/cli.js 的 version guard 拒——canonical
// runner（scripts/canonical-test.mjs）在父进程 env 注入 WAO_SKIP_VERSION_GUARD=1，
// 直接 focused 执行时没有。因此本 helper 在 child env 显式注入同一变量，让测试
// 自包含；不写全局/用户 env，不改生产代码。
function runCliOnPathNode(cmd) {
  return execSync(`node src/cli.js ${cmd}`, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
  });
}

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
      await runsDashboardCommand(["--run-dir", dir], { runDir: dir });
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
      await runsDashboardCommand(["--run-dir", dir, "--format", "json"], { runDir: dir });
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
      await runsDashboardCommand(["--run-dir", dir], { runDir: dir });
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
      await runsDashboardCommand(["--run-dir", dir], { runDir: dir });
    });
    assert.match(out, /No runs found/);
  } finally {
    rmrfRetry(dir);
  }
});

test("registry validate: prependArgs 必须是数组", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-registry-validate-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bad_claude: {
          backend: "claude-code",
          cwd: "D:/projects/app",
          prependArgs: "--bad",
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      "registry", "validate",
      "--registry", registryPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /prependArgs must be an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TD-79（Python 环境隔离：registry env 字段校验）─────────────────────────
test("TD-79: registry validate 拒绝非对象的 env 字段", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-registry-env-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bad_researcher: {
          backend: "claude-code",
          cwd: "D:/projects/app",
          env: "should-be-object", // 非 object → 应被拒
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      "registry", "validate",
      "--registry", registryPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /env must be an object/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-79: registry validate 拒绝 env 值非字符串的 env 字段", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-registry-env-val-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bad_researcher: {
          backend: "claude-code",
          cwd: "D:/projects/app",
          env: { PIP_REQUIRE_VIRTUALENV: 123 }, // 值非 string → 应被拒
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      "registry", "validate",
      "--registry", registryPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /env\.\w+ value must be a string/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-104: registry validate rejects secret-like agent.env keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-registry-secret-env-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bad_worker: {
          backend: "claude-code",
          cwd: "D:/projects/app",
          env: { SESSION_TOKEN: "test-secret-registry-value" },
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      "registry", "validate",
      "--registry", registryPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /secret-like.*inherited provider credential channel/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3: registry validate 拒绝缺 tokenBudget 的 opencode worker（06-18 事故防线硬门）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-budget-validate-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bad_opencode: {
          backend: "opencode-serve",
          serveUrl: "http://127.0.0.1:4297",
          agent: "build",
          cwd: "D:/projects/app",
          model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" },
          // 故意不配 tokenBudget
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      "registry", "validate",
      "--registry", registryPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0, "缺 tokenBudget 的 opencode worker 应校验失败");
    assert.match(result.stdout, /tokenBudget/i, "错误信息应提及 tokenBudget");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3: registry validate 接受配了 tokenBudget 的 opencode worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-budget-ok-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        good_opencode: {
          backend: "opencode-serve",
          serveUrl: "http://127.0.0.1:4297",
          agent: "build",
          cwd: "D:/projects/app",
          model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" },
          tokenBudget: 5000000,
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      "registry", "validate",
      "--registry", registryPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, "配了 tokenBudget 的 opencode worker 应校验通过");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2: 裸 spawn（不带 --wait）路由到 background runner 托管（06-18 架构洞正解）", () => {
  // P0-1 旧护栏（拒绝裸 spawn）已被 P2 替换：现在不拒，而是 fork detached runner 托管。
  // runner 拥有 worker handle，驱动 waitForCompletion（token 闸门/超时/兜底 abort 都生效），
  // 不再产生孤儿 session。这是 06-18 事故架构洞的正解（把"拒绝"换"接管生命周期"）。
  const dir = mkdtempSync(join(tmpdir(), "wao-fireandforget-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        glm_worker: {
          backend: "opencode-serve",
          serveUrl: "http://127.0.0.1:4297",
          agent: "build",
          cwd: dir,
          model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" },
          tokenBudget: 5000000,
        },
      },
    }), "utf8");
    const runDir = join(dir, "runs");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      "spawn", "glm_worker",
      "--prompt", "do anything",
      "--registry", registryPath,
      "--run-dir", runDir,
      // 故意不带 --wait → 应路由到 background runner（不再拒绝）
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10000,
    });

    // 不再拒绝（status 0）；返回 background:true JSON，说明托管给 detached runner。
    assert.equal(result.status, 0, "裸 spawn 应路由到 background（不再拒绝）");
    const out = result.stdout || "";
    assert.match(out, /"background":\s*true/, "应标记 background:true（托管给 runner）");
    assert.match(out, /"runId":\s*"/, "应返回 runId（runner 用它驱动生命周期）");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-54: run --background 默认透传 config.registry 且支持 --prompt-file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bg-default-reg-"));
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    const registryPath = join(dir, "config", "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bgw: {
          backend: "claude-code",
          binary: "nonexistent-binary-td54",
          cwd: dir,
          args: ["--dangerously-skip-permissions"],
        },
      },
    }), "utf8");
    const promptPath = join(dir, "task.txt");
    const promptText = "line one\nline two prompt-file content";
    writeFileSync(promptPath, promptText, "utf8");
    const runDir = join(dir, "runs");
    const cliPath = join(process.cwd(), "src", "cli.js");

    const result = spawnSync(process.execPath, [
      cliPath,
      "run", "bgw",
      "--prompt-file", promptPath,
      "--background",
      "--run-dir", runDir,
      "--wait-timeout", "2000",
      "--format", "json",
    ], { cwd: dir, encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 0, `background run 应立即返回 JSON: ${result.stderr}`);
    const out = result.stdout || "";
    const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    assert.equal(parsed.background, true);
    assert.ok(parsed.runId);

    const transcriptPath = join(runDir, `${parsed.runId}.jsonl`);
    let events = [];
    for (let i = 0; i < 50; i += 1) {
      if (existsSync(transcriptPath)) {
        events = await readTranscript(transcriptPath);
        if (["failed", "completed", "timed_out"].includes(findState(events))) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(events.length > 0, "background runner 必须写 transcript，不能返回 ghost runId");
    assert.equal(findState(events), "failed", "不存在 binary 应快速 failed");
    const sent = events.find((e) => e.type === "prompt.sent");
    assert.equal(sent?.prompt, promptText, "--prompt-file 内容必须完整进入 background runner");
  } finally {
    rmrfRetry(dir);
  }
});

test("WF-6: run --background 返回 runId 前必须已建立 status 可读 transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bg-status-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bgw: {
          backend: "claude-code",
          binary: "nonexistent-binary-wf6",
          cwd: dir,
          args: ["--dangerously-skip-permissions"],
        },
      },
    }), "utf8");
    const runDir = join(dir, "runs");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      "run", "bgw",
      "--prompt", "x",
      "--background",
      "--registry", registryPath,
      "--run-dir", runDir,
      "--wait-timeout", "2000",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 0, `background run 应立即返回: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.runId);
    assert.ok(existsSync(parsed.transcript), "CLI 返回 runId 时 transcript 必须已存在，status 才不会 ENOENT");

    const status = spawnSync(process.execPath, [
      "src/cli.js",
      "status", parsed.runId,
      "--run-dir", runDir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });

    assert.equal(status.status, 0, `status 必须立即可读: ${status.stderr}`);
    const statusJson = JSON.parse(status.stdout);
    assert.equal(statusJson.runId, parsed.runId);
    assert.ok(["pending", "submitted", "running", "failed", "completed", "timed_out", "aborted"].includes(statusJson.state));
  } finally {
    rmrfRetry(dir);
  }
});

test("run --format json: --scorecard-rules-file 从文件加载规则", async () => {
  const { ClaudeCodeBackend } = await import("../../src/backends/claudeCode.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-scorecard-file-"));
  try {
    const rulesPath = join(dir, "scorecard.json");
    writeFileSync(rulesPath, JSON.stringify({ requireCommands: ["npm test"] }), "utf8");
    const claudeLines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","subtype":"success","is_error":false}',
    ];
    const payload = Buffer.from(claudeLines.join("\n")).toString("base64");
    const script = `process.stdout.write(Buffer.from("${payload}","base64").toString("utf8")+"\\n");`;
    const backend = new ClaudeCodeBackend({ buildArgs: () => ["-e", script] });
    backend.defaultBinary = () => process.execPath;
    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        return { id, backend: "claude-code", cwd: dir, ...overrides };
      },
      listAgents() { return []; },
    });
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
      timeout: 5000, retries: 0, backendFor: () => backend, readRegistry,
    };

    const out = await captureLog(async () => {
      await runCommand([
        "claude_worker", "--prompt", "hi",
        "--scorecard-rules-file", rulesPath,
        "--format", "json",
        "--run-dir", dir,
      ], config);
    });
    const parsed = JSON.parse(out);
    const commandsCheck = parsed.scorecard.checks.find((c) => c.name === "commandsPassed");
    assert.ok(commandsCheck, "scorecard 应使用文件里的 requireCommands 规则");
    assert.equal(commandsCheck.passed, false, "mock run 没有命令证据，应按文件规则 warn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run --background: malformed --scorecard-rules-file fail-fast，不返回 runId", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bg-bad-scorecard-file-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_low: { backend: "claude-code", binary: "/nope", cwd: dir } },
    }), "utf8");
    const rulesPath = join(dir, "scorecard.json");
    writeFileSync(rulesPath, "{bad json", "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      "src/cli.js", "run", "coder_low",
      "--prompt", "x",
      "--background",
      "--registry", registryPath,
      "--run-dir", runDir,
      "--scorecard-rules-file", rulesPath,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });

    assert.notEqual(result.status, 0, "malformed scorecard rules file must fail in visible CLI process");
    assert.doesNotMatch(result.stdout, /"runId"/, "CLI must not print a runId for refused file rules");
    assert.match(result.stderr, /scorecard-rules-file|JSON/i);
  } finally {
    rmrfRetry(dir);
  }
});

test("P0-1: 裸 spawn 进程式 backend（claude-code/kimi）不受护栏限制（进程死即会话死）", () => {
  // 进程式 backend 的 session = 子进程；WAO 进程退出时子进程也会被回收
  // （taskkill /T 兜底 + 进程死即会话死的核心假设）。裸 spawn 对它们是安全的。
  // 护栏不得误伤进程式 backend —— 这是 runtime-agnostic 的体现
  // （护栏按 backend 属性 sessionOutlivesProcess 判定，不按 runtime 名分支）。
  const dir = mkdtempSync(join(tmpdir(), "wao-procsafe-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        kimi_worker: {
          backend: "kimi-code",
          binary: "node",
          cwd: dir,
          model: { providerID: "moonshot", id: "kimi-for-coding" },
        },
      },
    }), "utf8");
    const runDir = join(dir, "runs");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      "spawn", "kimi_worker",
      "--prompt", "x",
      "--registry", registryPath,
      "--run-dir", runDir,
      // 不带 --wait —— 对进程式 backend 应放行（不报 fire-and-forget 拒绝）
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 8000,
    });

    const out = (result.stdout || "") + (result.stderr || "");
    // 关键：不得出现 fire-and-forget 拒绝信息（进程式 backend 放行）。
    // 注意：kimi 可能因 binary 缺失等原因失败，但失败原因不应是 fire-and-forget 护栏。
    assert.ok(!/06-18|fire-and-forget|session.*outlive/i.test(out),
      "进程式 backend 不应被 fire-and-forget 护栏拦截（sessionOutlivesProcess=false）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-22: worktree list 列出所有 worktree（含主仓 + 新增）", () => {
  // 真实 git 仓 + worktree，验证 CLI `worktree list` 输出。
  const dir = mkdtempSync(join(tmpdir(), "wao-wt-list-"));
  try {
    // 建一个 git 仓
    execSync("git init -q", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "a.txt"), "a");
    execSync("git add -A && git commit -q -m init", { cwd: dir, stdio: "pipe" });
    // 建一个 worktree
    execSync("git worktree add -q ../wt-extra", { cwd: dir, stdio: "pipe" });

    const result = spawnSync(process.execPath, [
      "src/cli.js", "worktree", "list", "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 0, `worktree list 应成功: ${(result.stderr||"").slice(0,200)}`);
    const out = result.stdout;
    // 至少列出主仓 + 新增 worktree（JSON 数组或每行一个）
    assert.ok(/wt-extra/.test(out), "worktree list 应包含新增的 wt-extra");
  } finally {
    // 清理 worktree 引用（删 dir 前先 detach）
    try { execSync("git worktree remove --force ../wt-extra", { cwd: dir, stdio: "ignore" }); } catch {}
    rmSync(dir, { recursive: true, force: true });
    try { rmSync(join(dir, "..", "wt-extra"), { recursive: true, force: true }); } catch {}
  }
});

test("TD-22: worktree remove <path> 删除指定 worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wt-rm-"));
  const wtPath = join(dir, "..", "wt-to-remove");
  try {
    execSync("git init -q", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "a.txt"), "a");
    execSync("git add -A && git commit -q -m init", { cwd: dir, stdio: "pipe" });
    execSync("git worktree add -q ../wt-to-remove", { cwd: dir, stdio: "pipe" });

    const result = spawnSync(process.execPath, [
      "src/cli.js", "worktree", "remove", wtPath, "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 0, `worktree remove 应成功: ${(result.stderr||"").slice(0,200)}`);
    // worktree 目录应已删除
    assert.ok(!existsSync(wtPath), "worktree 目录应已被删除");
  } finally {
    try { execSync("git worktree remove --force ../wt-to-remove", { cwd: dir, stdio: "ignore" }); } catch {}
    rmSync(dir, { recursive: true, force: true });
    try { rmSync(wtPath, { recursive: true, force: true }); } catch {}
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
        certified_worker: {
          backend: "claude-code", binary: "/nonexistent/binary", cwd: dir,
          model: { providerID: "deepseek", id: "deepseek-v4-flash" },
        },
        unverified_worker: {
          backend: "claude-code", binary: "/nonexistent/binary", cwd: dir,
          model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" },
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
        certified_worker: { agentId: "certified_worker", backend: "claude-code", providerID: "deepseek", modelId: "deepseek-v4-flash", status: "certified", recommendedUse: "strict-dispatch", capabilities: {}, cases: [] },
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
        cert_w:   { backend: "claude-code", binary: "/nonexistent/binary", cwd: dir, model: { providerID: "x", id: "y" } },
        cond_w:   { backend: "claude-code", binary: "/nonexistent/binary", cwd: dir, model: { providerID: "x", id: "y" } },
        draft_w:  { backend: "claude-code", binary: "/nonexistent/binary", cwd: dir, model: { providerID: "x", id: "y" } },
        reject_w: { backend: "claude-code", binary: "/nonexistent/binary", cwd: dir, model: { providerID: "x", id: "y" } },
      },
    }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      version: 1, generatedAt: new Date().toISOString(),
      counts: { certified: 1, conditional: 1, draftOnly: 1, blocked: 0, rejected: 1 },
      workers: {
        cert_w:   { agentId: "cert_w", status: "certified", recommendedUse: "strict-dispatch", capabilities: {}, cases: [] },
        cond_w:   { agentId: "cond_w", status: "conditional", recommendedUse: "supervised-dispatch", capabilities: {}, cases: [] },
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
        cleared_w: { backend: "claude-code", binary: "/nonexistent/binary", cwd: dir, model: { providerID: "x", id: "y" } },
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

// --- N1 修复：registry list 合并认证状态列 ---
test("registry list 合并认证状态列（summary 存在时显示 cert 状态）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reglist-cert-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_hq:   { backend: "claude-code", binary: "/x", cwd: dir, model: { id: "glm-5.2" } },
        researcher: { backend: "claude-code", binary: "/x", cwd: dir, model: { id: "deepseek-v4-flash" } },
      },
    }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true, force: true });
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      workers: {
        coder_hq:   { status: "certified" },
        researcher: { status: "conditional" },
      },
    }));

    const out = runCliOnPathNode(`registry list --registry ${registryPath} --run-dir ${runDir}`);
    const lines = out.trim().split(/\r?\n/);
    assert.equal(lines.length, 3, "应输出表头 + 2 个 agent 行");
    assert.equal(lines[0], "id\tbackend\tmodel\tcertification\tcwd", "首行应为表头（tab 分隔）");
    const hqLine = lines.find((l) => l.startsWith("coder_hq"));
    assert.ok(hqLine, "应有 coder_hq 行");
    assert.match(hqLine, /certified/, "coder_hq 应显示 certified");
    const resLine = lines.find((l) => l.startsWith("researcher"));
    assert.match(resLine, /conditional/, "researcher 应显示 conditional");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry list 无 summary 时不报错（cert 列显示 -）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reglist-nosum-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_hq: { backend: "claude-code", binary: "/x", cwd: dir, model: { id: "glm-5.2" } } },
    }), "utf8");

    const out = runCliOnPathNode(`registry list --registry ${registryPath}`);
    assert.match(out.trim(), /coder_hq\tclaude-code\tglm-5\.2.*-/, "无 summary 时 cert 列显示 -");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WF-8: registry list 对 kimi/codex 默认模型显示非 '-'", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reglist-default-model-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_mm: { backend: "kimi-code", cwd: dir },
        tester: { backend: "codex", cwd: dir, args: [] },
      },
    }), "utf8");

    const out = runCliOnPathNode(`registry list --registry ${registryPath}`);
    const lines = out.trim().split(/\r?\n/);
    for (const id of ["coder_mm", "tester"]) {
      const line = lines.find((l) => l.startsWith(`${id}\t`));
      assert.ok(line, `${id} 应列出`);
      const fields = line.split("\t");
      assert.notEqual(fields[2], "-", `${id} 的 model 列不得再显示 '-'`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F17: registry list --format json 输出可解析 JSON（dogfood round 4 实证 bug）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reglist-json-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_hq: { backend: "claude-code", binary: "/x", cwd: dir, model: { id: "glm-5.2" } },
        researcher: { backend: "claude-code", binary: "/x", cwd: dir, model: { id: "deepseek-v4-flash" } },
      },
    }), "utf8");

    const out = runCliOnPathNode(`registry list --registry ${registryPath} --run-dir ${dir} --format json`);
    // 必须是合法 JSON 数组（原 bug：接受 --format json 但仍输出 tab 表格，JSON.parse 会抛）
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed), "输出应是 JSON 数组");
    assert.equal(parsed.length, 2, "含 2 个 agent");
    const hq = parsed.find((a) => a.id === "coder_hq");
    assert.ok(hq, "含 coder_hq");
    assert.equal(hq.backend, "claude-code", "backend 字段正确");
    assert.equal(hq.model, "glm-5.2", "model 字段正确");
    assert.equal(hq.certification, null, "无 summary（--run-dir 指向空目录）时 certification 为 null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-87: registry validate 对 kimi-code 配 tokenBudget 给 ⚠ warning（静默无效陷阱）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-regval-kimi-budget-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_mm: { backend: "kimi-code", cwd: dir, tokenBudget: 100000 },
      },
    }), "utf8");

    const out = runCliOnPathNode(`registry validate --registry ${registryPath}`);
    // validate 通过（✔），但有 ⚠ warning 提示 tokenBudget 对 kimi 无效
    assert.match(out, /✔\s*coder_mm/, "kimi worker validate 通过");
    assert.match(out, /⚠.*kimi-code.*tokenBudget.*不生效/, "配了 tokenBudget 的 kimi worker 应有 ⚠ warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-89 (M11-5 resolved): registry validate accepts systemPrompt for all backends, fail-closed on bad role file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-regval-sysprompt-"));
  try {
    // M11-5 后：所有三个 process backend 都消费 systemPrompt。旧的"kimi/codex 不消费
    // systemPrompt"warning 已删除。registry validate 用共享加载器对所有配 systemPrompt
    // 的 backend 统一 fail-closed 验证（缺失/目录/空/超限/非法 UTF-8/NUL）。
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        // kimi-code + valid systemPrompt → 应 pass（不再 warn）
        coder_mm: { backend: "kimi-code", cwd: dir, systemPrompt: "config/roles/coder_mm.md" },
        // codex + valid systemPrompt → 应 pass（不再 warn）
        tester: { backend: "codex", cwd: dir, systemPrompt: "config/roles/tester.md" },
        // claude-code + valid systemPrompt → 应 pass
        researcher: { backend: "claude-code", cwd: dir, systemPrompt: "config/roles/researcher.md" },
      },
    }), "utf8");

    const out = runCliOnPathNode(`registry validate --registry ${registryPath}`);
    // 三个都 pass（无 ✖，无旧 ⚠ "不消费 systemPrompt" warning）
    assert.match(out, /✔\s*coder_mm/, "kimi-code + systemPrompt passes");
    assert.match(out, /✔\s*tester/, "codex + systemPrompt passes");
    assert.match(out, /✔\s*researcher/, "claude-code + systemPrompt passes");
    // 不再有"不消费 systemPrompt"warning
    assert.doesNotMatch(out, /不消费 systemPrompt/, "old TD-89 warning removed");
    assert.match(out, /all valid/, "registry fully valid");

    // fail-closed: 非法角色文件（缺失）→ ✖ + exit 1
    const badRegistryPath = join(dir, "agents-bad.json");
    writeFileSync(badRegistryPath, JSON.stringify({
      agents: {
        bad_worker: { backend: "codex", cwd: dir, systemPrompt: join(dir, "nonexistent-role.md") },
      },
    }), "utf8");
    // registry validate exits 1 when there are errors — use spawnSync to capture non-zero exit.
    const badResult = spawnSync(process.execPath,
      ["src/cli.js", "registry", "validate", "--registry", badRegistryPath],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(badResult.status, 0, "registry validate exits non-zero on bad role");
    assert.match(badResult.stdout, /✖\s*bad_worker.*角色合同无效/, "missing role file → fail-closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-90: getWaoCliPath 在 win32 返回 .cmd shim（worker 不踩 v24 guard）", async () => {
  // dogfood round 7 实证：worker 收到的 $WAO_CLI 原指向裸 src/cli.js，worker shell
  // 默认 node v24，直接 `node $WAO_CLI` 触发 nodeVersionGuard 被拒。TD-90 修复让
  // Windows 上 getWaoCliPath 返回 scripts/wao-cli.cmd（内部用 v22 node 绝对路径）。
  const { getWaoCliPath } = await import("../../src/waoCliPath.js");
  const p = getWaoCliPath();
  if (process.platform === "win32") {
    // Windows：必须是 .cmd shim，且该文件真实存在
    assert.ok(p.endsWith("wao-cli.cmd"), `win32 上 WAO_CLI 应指向 .cmd shim，实际：${p}`);
    assert.ok(existsSync(p), `wao-cli.cmd 文件必须存在：${p}`);
  } else {
    // 非 Windows：回退裸 cli.js（无 v24 guard 问题）
    assert.ok(p.endsWith("cli.js"), `非 win32 应回退 cli.js，实际：${p}`);
  }
});

// TD-52 守卫：help 必须列出 main() 真实路由的全部命令族。
// canonical runner（scripts/canonical-test.mjs）在子进程 env 注入 WAO_SKIP_VERSION_GUARD=1；
// 且 help 本身豁免 version guard——故 help 在测试里可跑。
// 防止 printHelp 与代码漂移（首装 e2e 摩擦日志 F1：曾漏列 dashboard/diagnose/wao 族/daemon supervise）。
test("help: 列出所有 main() 真实路由的命令族（防 help 与代码漂移，TD-52）", () => {
  const out = execSync("node src/cli.js help", { cwd: process.cwd(), encoding: "utf8" });
  assert.match(out, /run <agentId> .*--prompt-file FILE/, "help 必须列出 run --prompt-file FILE");
  assert.match(out, /--scorecard-rules-file FILE/, "help 必须列出 --scorecard-rules-file FILE");
  assert.match(out, /status <runId> .*--format json/, "help 必须列出 status --format json");
  // runs 族（M8-2/3 新增，曾漏）
  assert.match(out, /runs dashboard/, "help 必须列出 runs dashboard（main() 路由）");
  assert.match(out, /runs diagnose/, "help 必须列出 runs diagnose（main() 路由）");
  assert.match(out, /runs wait/, "help 必须列出 runs wait（TD-109 runs wait 命令）");
  assert.doesNotMatch(out, /runs forecast/, "已移除的 forecast 不得继续出现在 help");
  // wao 族（整族曾缺席）
  assert.match(out, /wao init/, "help 必须列出 wao init");
  assert.match(out, /wao state/, "help 必须列出 wao state");
  assert.match(out, /wao decision/, "help 必须列出 wao decision");
  assert.match(out, /wao declare/, "help 必须列出 wao declare（TD-82 自做声明）");
  assert.match(out, /wao stage/, "help 必须列出 wao stage（TD-83 阶段声明）");
  assert.match(out, /wao ask/, "help 必须列出 wao ask（TD-88 快捷派工）");
  assert.match(out, /wao handoff/, "help 必须列出 wao handoff");
  assert.match(out, /wao doctor/, "help 必须列出 wao doctor");
  // daemon 补充族（P5/TD-45/46，曾漏）
  assert.match(out, /daemon supervise/, "help 必须列出 daemon supervise");
  assert.match(out, /daemon supervisor/, "help 必须列出 daemon supervisor");
  assert.match(out, /daemon health/, "help 必须列出 daemon health");
  assert.match(out, /workflow list/, "help 必须列出 workflow list（TD-88 模板库）");
  // mcp 族（M10 P0-1 workspace activation）
  assert.match(out, /mcp bind/, "help 必须列出 mcp bind（M10 P0-1 workspace activation）");
  assert.match(out, /mcp status/, "help 必须列出 mcp status");
  assert.match(out, /mcp unbind/, "help 必须列出 mcp unbind");
  // TD-86（D2 A1）：七命令 --format json 能力入 help（新增断言，防 help 与实现漂移）。
  assert.match(out, /registry check [^\n]*--format json/, "help 必须标注 registry check --format json（TD-86）");
  assert.match(out, /registry validate [^\n]*--format json/, "help 必须标注 registry validate --format json（TD-86）");
  assert.match(out, /runs list [^\n]*--format json/, "help 必须标注 runs list --format json（TD-86）");
  assert.match(out, /runs summary [^\n]*--format json/, "help 必须标注 runs summary --format json（TD-86）");
  assert.match(out, /runs grep <pattern> [^\n]*--format json/, "help 必须标注 runs grep --format json（TD-86）");
  assert.match(out, /wao decision list \[--format json\]/, "help 必须标注 wao decision list --format json（TD-86）");
  assert.match(out, /wao handoff read <role> \[--format json\]/, "help 必须标注 wao handoff read --format json（TD-86）");
  // TD-112（D2 A4）：collect --final（最终 assistant 文本一屏出口）入 help。
  assert.match(out, /collect <runId> [^\n]*--final/, "help 必须列出 collect --final（TD-112）");
});

test("TD-82: wao declare 写入声明 + wao declare（裸）列出汇总（端到端）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-declare-e2e-"));
  try {
    // 先 init .wao/（declare 依赖 decisions/ 槽位）
    spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    // 写一条声明
    const r = spawnSync(process.execPath, [
      "src/cli.js", "wao", "declare",
      "--task", "改了 help 文本",
      "--reason", "too-small",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, `declare 应成功，stderr=${r.stderr}`);
    assert.match(r.stdout, /"declared": true/, "输出 declared:true");
    assert.match(r.stdout, /"reason": "too-small"/, "输出 reason");
    // 裸 wao declare 列出汇总
    const r2 = spawnSync(process.execPath, ["src/cli.js", "wao", "declare", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.match(r2.stdout, /"count": 1/, "汇总 count:1");
    assert.match(r2.stdout, /"too-small": 1/, "byReason 含 too-small:1");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-82: wao declare 非法 reason fail-fast（枚举约束）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-declare-bad-"));
  try {
    spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    const r = spawnSync(process.execPath, [
      "src/cli.js", "wao", "declare",
      "--task", "x", "--reason", "因为我想",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.notEqual(r.status, 0, "非法 reason 必须 fail-fast");
    assert.match(r.stderr, /reason 必须是枚举值/, "stderr 解释合法枚举值");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-83: wao stage 写入声明 + wao stage（裸）列出 pipeline 缺口（端到端）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stage-e2e-"));
  try {
    spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    // 走阶段 1（spec）+ 阶段 3（派发）——典型"敷衍"模式：跳了 2/4/5/6
    const r = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "1",
      "--task", "起草 auth 契约",
      "--artifacts", "docs/01-prd.md",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, `stage 1 应成功，stderr=${r.stderr}`);
    assert.match(r.stdout, /"staged": true/, "输出 staged:true");
    assert.match(r.stdout, /"stage": 1/, "输出 stage:1");

    const r2 = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "3",
      "--task", "派发实现",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r2.status, 0, `stage 3 应成功`);

    // 裸 wao stage 列出 pipeline 进度 + 缺口
    const r3 = spawnSync(process.execPath, ["src/cli.js", "wao", "stage", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.match(r3.stdout, /"count": 2/, "声明 2 个阶段");
    assert.match(r3.stdout, /"progress": "\[1\]✓ \[2\]— \[3\]✓ \[4\]— \[5\]— \[6\]—"/,
      "progress 行显示阶段 1/3 已声明、2/4/5/6 缺口");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-83: wao stage 非法 stage 号 fail-fast（枚举约束，防跳号）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stage-bad-"));
  try {
    spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    const r = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "7",
      "--task", "x",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.notEqual(r.status, 0, "非法 stage 号（7）必须 fail-fast");
    assert.match(r.stderr, /stage 必须是/, "stderr 解释合法枚举值");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-95 #7: stage artifact 含 run 路径时存为绝对路径（跨项目可解析）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stage-artifact-"));
  try {
    spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    // 模拟跨项目派工：artifact 是 runs/run_xxx.jsonl（相对 WAO repo，不是 --cwd 目标）
    const r = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "3",
      "--task", "派发实现",
      "--artifacts", "runs/run_test123.jsonl",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, `stage 3 应成功，stderr=${r.stderr}`);
    // 读 stage 正文，确认 artifact 是绝对路径（跨项目时可解析）
    const stageFiles = readdirSync(join(dir, ".wao", "pipeline")).filter((f) => f.startsWith("STAGE-3"));
    assert.ok(stageFiles.length === 1, "应有 1 个 STAGE-3 文件");
    const body = readFileSync(join(dir, ".wao", "pipeline", stageFiles[0]), "utf8");
    // artifact 应是绝对路径（含盘符 + run_test123.jsonl），不是裸 runs/run_test123.jsonl
    assert.ok(body.includes("run_test123.jsonl"), "artifact 应含 run_test123.jsonl");
    assert.ok(/[A-Za-z]:[\\/].*run_test123/.test(body),
      "artifact 应是绝对路径（含盘符），实际：" + body.slice(0, 200));
  } finally {
    rmrfRetry(dir);
  }
});

// ── R9（决策 0023）：wao stage panel 字段（三席会审产品化，advisory 非门禁）──
//
// 需求 3（2/4 接受、1/3/5/6 拒绝、同 stage 多条记录）与需求 4（无 panel →
// panelAdvisory + stdout 纯 JSON + exit 0；非法 skip 码/互斥 fail-fast）的
// 端到端行为断言。registry 用临时目录 fixture（绝无真实派发）。

/** R9 fixture：临时项目目录 + .wao/ init + 双 worker registry（coder_hq/auditor）。 */
function makePanelFixture(name) {
  const dir = mkdtempSync(join(tmpdir(), name));
  spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  const registry = join(dir, "agents.json");
  writeFileSync(registry, JSON.stringify({
    agents: {
      coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, cwd: "." },
      auditor: { backend: "claude-code", cwd: "." },
    },
  }), "utf8");
  return { dir, registry };
}

test("R9 需求 3: stage 2/4 接受 --panel-seats（registry 校验 + 自报标注 + map/自省留痕），1/3/5/6 拒绝", () => {
  const { dir, registry } = makePanelFixture("wao-stage-panel-acc-");
  try {
    // stage 2 接受 seats：输出纯 JSON，panel.seats 在场且标注自报未验证。
    const r2 = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "2",
      "--task", "方案定稿",
      "--panel-seats", "coder_hq,auditor",
      "--registry", registry,
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r2.status, 0, `stage 2 带 panel-seats 应成功，stderr=${r2.stderr}`);
    const out2 = JSON.parse(r2.stdout);
    assert.deepEqual(out2.panel.seats, ["coder_hq", "auditor"]);
    assert.match(out2.panel.note, /自报、未验证/);
    assert.match(out2.panel.note, /--artifacts/);
    // stage 4 接受 skip：skipReason 在场 + 红线句复述。
    const r4 = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "4",
      "--task", "交付验收",
      "--panel-skip-reason", "low_risk_small_task",
      "--registry", registry,
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r4.status, 0, `stage 4 带 skip 应成功，stderr=${r4.stderr}`);
    const out4 = JSON.parse(r4.stdout);
    assert.equal(out4.panel.skipReason, "low_risk_small_task");
    assert.match(out4.acceptanceRedLine, /评审意见是证据不是验收；run_delivery_decide 只由 Lead 调用/);
    // 1/3/5/6 带 panel 参数 → fail-fast，文案必须是两节点限定句。
    for (const n of [1, 3, 5, 6]) {
      const bad = spawnSync(process.execPath, [
        "src/cli.js", "wao", "stage", String(n),
        "--task", "x",
        "--panel-seats", "coder_hq",
        "--registry", registry,
        "--cwd", dir,
      ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
      assert.notEqual(bad.status, 0, `stage ${n} 带 panel 参数必须 fail-fast`);
      assert.match(bad.stderr, /panel 字段只在方案（2）\/交付物验收（4）登记/,
        `stage ${n} 拒绝文案必须是两节点限定句（不是"会审仅发生在两节点"）`);
    }
    // map 索引行第 5 列 panel 摘要 + 裸 wao stage 可检索。
    const map = readFileSync(join(dir, ".wao", "pipeline", "map.md"), "utf8");
    assert.match(map, /STAGE \| 2 \| [^|]+\| [^|]+\| panel=seats:coder_hq\+auditor/);
    assert.match(map, /panel=skip:low_risk_small_task/);
    const bare = spawnSync(process.execPath, ["src/cli.js", "wao", "stage", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(bare.status, 0);
    const summary = JSON.parse(bare.stdout);
    assert.equal(summary.panel.records, 2);
    assert.equal(summary.panel.seatsRecords, 1);
    assert.deepEqual(summary.panel.bySkipReason, { low_risk_small_task: 1 });
  } finally {
    rmrfRetry(dir);
  }
});

test("R9 需求 4: 无 panel 的 stage 2/4 → panelAdvisory + stdout 仍可 JSON.parse + exit 0（非门禁钉死）", () => {
  const { dir } = makePanelFixture("wao-stage-panel-nudge-");
  try {
    for (const n of [2, 4]) {
      const r = spawnSync(process.execPath, [
        "src/cli.js", "wao", "stage", String(n),
        "--task", `t${n}`,
        "--cwd", dir,
      ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
      assert.equal(r.status, 0, `stage ${n} 无 panel 必须照常成功（advisory 非门禁），stderr=${r.stderr}`);
      const out = JSON.parse(r.stdout); // stdout 是纯 JSON——任何提示只能走加性字段
      assert.match(out.panelAdvisory, /未记录会审——三席会审是推荐标准（决策 0023）/);
      assert.match(out.panelAdvisory, /--panel-skip-reason/);
      assert.ok(!("panel" in out), "无 panel 字段时输出 panel 对象不在场");
    }
    // stage 1/3/5/6 无 panel：不给 nudge（两节点限定）。
    const r3 = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "3", "--task", "t3", "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r3.status, 0);
    assert.ok(!JSON.parse(r3.stdout).panelAdvisory, "stage 3 无 panel 不给 nudge");
  } finally {
    rmrfRetry(dir);
  }
});

test("R9 需求 3/4: 非法 skip 码、seats/skip 互斥、registry 外 seats 都 fail-fast；同 stage 两条记录都留痕", () => {
  const { dir, registry } = makePanelFixture("wao-stage-panel-reject-");
  const run = (args) => spawnSync(process.execPath,
    ["src/cli.js", "wao", "stage", ...args, "--registry", registry, "--cwd", dir],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  try {
    // 非法 skip 码（闭集外）→ fail-fast，stderr 列出合法闭集。
    const badSkip = run(["2", "--task", "x", "--panel-skip-reason", "因为我想"]);
    assert.notEqual(badSkip.status, 0, "非法 skip 码必须 fail-fast");
    assert.match(badSkip.stderr, /--panel-skip-reason 必须是闭集值之一/);
    assert.match(badSkip.stderr, /no_reviewer_available/);
    // seats 与 skip 同给 → 互斥 fail-fast。
    const both = run(["2", "--task", "x", "--panel-seats", "coder_hq", "--panel-skip-reason", "time_critical"]);
    assert.notEqual(both.status, 0, "seats/skip 互斥必须 fail-fast");
    assert.match(both.stderr, /互斥/);
    // registry 里不存在的 worker → fail-fast（自报也要是已配置 worker）。
    const ghost = run(["2", "--task", "x", "--panel-seats", "ghost_worker"]);
    assert.notEqual(ghost.status, 0, "registry 外 seats 必须 fail-fast");
    assert.match(ghost.stderr, /registry 里不存在的 worker: ghost_worker/);
    // 同一 stage 两条 panel 记录（返工/窄复核的真实形状）都留痕且可检索。
    assert.equal(run(["2", "--task", "首轮方案", "--panel-seats", "coder_hq,auditor"]).status, 0);
    assert.equal(run(["2", "--task", "返工窄复核", "--panel-skip-reason", "owner_direct"]).status, 0);
    const bare = spawnSync(process.execPath, ["src/cli.js", "wao", "stage", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    const summary = JSON.parse(bare.stdout);
    const stage2Panels = summary.stages.filter((s) => s.stage === 2).map((s) => s.panel);
    assert.equal(stage2Panels.length, 2, "同 stage 两条 panel 记录都在（无唯一性校验）");
    assert.ok(stage2Panels.some((p) => p?.seats && p.seats.join(",") === "coder_hq,auditor"));
    assert.ok(stage2Panels.some((p) => p?.skipReason === "owner_direct"));
  } finally {
    rmrfRetry(dir);
  }
});

test("R9 兼容: 无 panel 第 5 列的旧 STAGE 索引行照常解析（July pilot 形状）", () => {
  const { dir } = makePanelFixture("wao-stage-panel-compat-");
  try {
    // 手工构造新旧两种行并存（主仓 .wao/pipeline/map.md 的 July pilot 旧行在
    // worktree 内不存在——这里用临时目录构造等价形状）。
    const mapPath = join(dir, ".wao", "pipeline", "map.md");
    writeFileSync(mapPath, [
      "# Pipeline Map",
      "",
      "STAGE | 1 | 旧形状四列：无 panel | docs/01-prd.md",
      `STAGE | 2 | 新形状：有 panel | docs/plan.md | panel=seats:coder_hq+auditor`,
      "",
    ].join("\n"), "utf8");
    const bare = spawnSync(process.execPath, ["src/cli.js", "wao", "stage", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(bare.status, 0, `旧行混合必须照常解析，stderr=${bare.stderr}`);
    const summary = JSON.parse(bare.stdout);
    assert.equal(summary.count, 2);
    const old = summary.stages.find((s) => s.stage === 1);
    assert.equal(old.panel, null, "旧行（无第 5 列）panel 解析为 null");
    assert.equal(old.artifact, "docs/01-prd.md", "旧行既有列不受影响");
    const neu = summary.stages.find((s) => s.stage === 2);
    assert.deepEqual(neu.panel.seats, ["coder_hq", "auditor"], "新行第 5 列照常解析");
    assert.equal(summary.panel.records, 1, "旧行不计入 panel 记录");
  } finally {
    rmrfRetry(dir);
  }
});

test("R9-C C-8: stage 4 STAGE 正文固定写入红线句（panel 与无 panel 两种；stdout 之外的持久化）", () => {
  const { dir, registry } = makePanelFixture("wao-stage-redline-");
  try {
    const RED_LINE = "评审意见是证据不是验收；run_delivery_decide 只由 Lead 调用";
    // 带 panel（skip 形态）的 stage 4：正文必须含红线句。
    const withPanel = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "4",
      "--task", "交付验收",
      "--panel-skip-reason", "low_risk_small_task",
      "--registry", registry, "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(withPanel.status, 0, `stage 4 skip 应成功，stderr=${withPanel.stderr}`);
    const body1 = readFileSync(JSON.parse(withPanel.stdout).path, "utf8");
    assert.ok(body1.includes(RED_LINE), "带 panel 的 stage 4 正文必须落盘红线句");
    // 无 panel 的 stage 4：正文同样必须含（panelAdvisory 路径）。
    const noPanel = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "4", "--task", "交付验收补登", "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(noPanel.status, 0, `无 panel stage 4 应成功，stderr=${noPanel.stderr}`);
    const body2 = readFileSync(JSON.parse(noPanel.stdout).path, "utf8");
    assert.ok(body2.includes(RED_LINE), "无 panel 的 stage 4 正文必须落盘红线句");
    // 反向钉：stage 2（方案节点）正文不写验收红线句——红线只在验收节点落盘。
    const plan = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "2", "--task", "方案定稿", "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(plan.status, 0);
    const body3 = readFileSync(JSON.parse(plan.stdout).path, "utf8");
    assert.ok(!body3.includes(RED_LINE), "stage 2 正文不含验收红线句（两节点限定）");
  } finally {
    rmrfRetry(dir);
  }
});

test("R9-C C-13: --panel-seats 的 registry 存在性校验四路径 fail-fast（读失败/解析失败/缺 agents 表/未知 id）", () => {
  const { dir } = makePanelFixture("wao-stage-seats-validate-");
  const run = (registryPath) => spawnSync(process.execPath,
    ["src/cli.js", "wao", "stage", "2", "--task", "x", "--panel-seats", "coder_hq",
      "--registry", registryPath, "--cwd", dir],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  try {
    // 路径 1：registry 文件不存在（读取失败）。
    const readFail = run(join(dir, "nope", "agents.json"));
    assert.notEqual(readFail.status, 0, "registry 读失败必须 fail-fast");
    assert.match(readFail.stderr, /读取失败/, "读失败文案指明先跑 onboarding 或 --registry 指向有效 registry");
    // 路径 2：文件在但 JSON 解析失败。
    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{ not json", "utf8");
    const parseFail = run(badJson);
    assert.notEqual(parseFail.status, 0, "解析失败必须 fail-fast");
    assert.match(parseFail.stderr, /解析失败/, "解析失败文案指向 registry validate");
    // 路径 3：JSON 合法但缺可用 agents 表。
    const noAgents = join(dir, "no-agents.json");
    writeFileSync(noAgents, JSON.stringify({ foo: 1 }), "utf8");
    const agentsFail = run(noAgents);
    assert.notEqual(agentsFail.status, 0, "缺 agents 表必须 fail-fast");
    assert.match(agentsFail.stderr, /缺少可用 agents 表/);
    // 路径 4：agents 表在场但 seats 引用未知 id（此前唯一有覆盖的路径——回归钉）。
    const unknown = join(dir, "unknown.json");
    writeFileSync(unknown, JSON.stringify({
      agents: { coder_low: { backend: "claude-code", provider: { apiKeyEnv: "DEEPSEEK_API_KEY" }, cwd: "." } },
    }), "utf8");
    const ghost = run(unknown);
    assert.notEqual(ghost.status, 0, "未知 id 必须 fail-fast");
    assert.match(ghost.stderr, /registry 里不存在的 worker: coder_hq/);
  } finally {
    rmrfRetry(dir);
  }
});

test("R9 回归: wao onboarding refused/error 分支 exitCode 行为不受分级块影响（拒绝仍 exit 1，preview 仍 exit 0）", () => {
  // 拒绝路径：--agent ghost（模板里不存在的 id）→ outcome refused → exit 1。
  // 零写（refused 在任何写之前返回）；读真实入库模板（只读）。
  const refused = spawnSync(process.execPath,
    ["src/cli.js", "wao", "onboarding", "--agent", "ghost_worker"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 60000 });
  assert.equal(refused.status, 1, "refused outcome 必须 exit 1（脚本/CI 门控语义不变）");
  // preview 路径：模板真实存在的 tester（零写）→ exit 0，且 selected 分支打印分级块。
  const preview = spawnSync(process.execPath,
    ["src/cli.js", "wao", "onboarding", "--agent", "tester"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 60000 });
  assert.equal(preview.status, 0, `preview outcome 必须 exit 0，stderr=${preview.stderr}`);
  // R10 集成修正：分级块的数据面（模板面/已配置面）取决于本机是否存在私有
  // config/agents.json——fresh worktree/CI 无（模板面）、已配置机器有（已配置
  // 面）。本测试只断言跨机稳定事实（selected 分支打印分级块本身），不钉面
  // （R7-C C-6 的机器状态解耦纪律同款）。
  assert.match(preview.stdout, /会审就绪（(模板面|已配置面)/, "selected/preview 分支打印分级块（R9 需求 1）");
});

test("TD-88: wao ask 缺 agentId 或任务时 fail-fast（快捷派工参数校验）", () => {
  // 缺 agentId
  const r1 = spawnSync(process.execPath, ["src/cli.js", "wao", "ask"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.notEqual(r1.status, 0, "缺 agentId 必须 fail-fast");
  assert.match(r1.stderr, /requires <agentId>/, "stderr 提示需要 agentId");

  // 有 agentId 缺任务
  const r2 = spawnSync(process.execPath, ["src/cli.js", "wao", "ask", "researcher"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.notEqual(r2.status, 0, "缺任务必须 fail-fast");
  assert.match(r2.stderr, /requires 一句话任务/, "stderr 提示需要一句话任务");
});

test("TD-88: workflow list 列出模板 + workflow run 按名字解析（R7-AB：临时 run-dir，占位 cwd 派发前拒绝）", () => {
  // workflow list 应列出 analyze-implement 和 parallel-research 两个模板
  const r = spawnSync(process.execPath, ["src/cli.js", "workflow", "list"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, `workflow list 应成功，stderr=${r.stderr}`);
  assert.match(r.stdout, /analyze-implement/, "list 应列出 analyze-implement 模板");
  assert.match(r.stdout, /parallel-research/, "list 应列出 parallel-research 模板");
  assert.match(r.stdout, /workflow run <名字>/, "list 提示按名字调用用法");

  // R7-AB 测试卫生：workflow run 的 agent 节点此前不带 --run-dir，会真实派发
  // 2 路 researcher（example registry 的占位 cwd D:/projects/your-project），
  // 失败 transcript 直接泄漏进仓库真实 runs/。现在显式指向临时 run-dir——
  // 本测试对仓库 runs/ 的写入结构性归零（任何机器、任何 env 下均成立）。
  //
  // R7-C（C-6）与机器状态解耦：不再依赖 D:/projects/your-project 在本机不
  // 存在（该路径存在的机器上本测试会硬失败且真实派发）。改用 fixture
  // registry——形状来源 config/agents.example.json 的 researcher 条目
  // （claude-code 进程式 backend），cwd 指向本测试 tmpdir 下的随机必缺路径，
  // 任何机器上确定性不存在。
  const dir = mkdtempSync(join(tmpdir(), "wao-td88-wf-"));
  try {
    const wfRunDir = join(dir, "wf-runs");
    const bgRunDir = join(dir, "bg-runs");
    const badCwd = join(dir, `no-such-project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const fixtureRegistry = join(dir, "agents.td88-fixture.json");
    writeFileSync(fixtureRegistry, JSON.stringify({
      agents: {
        researcher: { backend: "claude-code", cwd: badCwd },
      },
    }), "utf8");

    // 按名字调用应解析到 templates/ 目录。不验证 workflow 执行结果（节点失败
    // 是 per-node catch，引擎照常收尾输出汇总），只验证名字解析不报"找不到文件"
    // ——原意图（验证名字解析不报 MODULE_NOT_FOUND）保持不变。
    const r2 = spawnSync(process.execPath, [
      "src/cli.js", "workflow", "run", "parallel-research",
      "--vars", "topicA=testA", "--vars", "topicB=testB",
      "--registry", fixtureRegistry, // fixture（example 形状，cwd 必缺）——不依赖 example 占位路径在本机不存在
      "--run-dir", wfRunDir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 15000 });
    assert.doesNotMatch(r2.stderr || "", /MODULE_NOT_FOUND|Cannot find module.*parallel-research/,
      "按名字调用应解析到模板文件，不报模块未找到");
    assert.equal(r2.status, 0, `workflow 引擎应跑完并输出节点汇总，stderr=${r2.stderr}`);
    assert.match(r2.stdout, /"workflowRunId": "wf_/, "输出 workflow 级 runId");

    // R7-AB 层二（workflow 节点通道，事故通道）：fixture 的必缺 cwd 在
    // RunManager.start 被 typed 拒绝——agent 节点 completed:false 且无 runId
    // （run 从未 start），临时 run-dir 只含 workflow 级 transcript、零 run
    // transcript。typed 文案断言钉在持久层（wf_*.jsonl 的
    // workflow.node.completed.error，R7-C C-1）：
    // run-lifecycle/runManagerCwdExistence.test.js RCE-8。
    const summary = JSON.parse(r2.stdout);
    assert.equal(summary.completed, false, "节点失败 → workflow 整体 completed:false");
    for (const nodeId of ["research_a", "research_b"]) {
      assert.ok(summary.nodes[nodeId], `${nodeId} 节点出现在汇总里`);
      assert.equal(summary.nodes[nodeId].completed, false, `${nodeId} 因必缺 cwd 被拒`);
      assert.equal(summary.nodes[nodeId].runId, undefined, `${nodeId} 无 runId——run 在 start 前置校验被拒，从未创建`);
      assert.match(summary.nodes[nodeId].error, /dispatch_cwd_not_found/,
        `${nodeId} 汇总透出闭集 reason code（R7-C C-1 CLI 投影）`);
    }
    const wfJsonl = existsSync(wfRunDir) ? readdirSync(wfRunDir).filter((f) => f.endsWith(".jsonl")) : [];
    assert.equal(wfJsonl.length, 1, "run-dir 只含 workflow 级 transcript");
    assert.match(wfJsonl[0], /^wf_/, "唯一 transcript 是 workflow 级（wf_ 前缀）");

    // R7-AB 层一（同一缺陷的后台派发面，预防性）：fixture 的必缺 cwd 在派发
    // 服务层被 typed 拒绝。这里用【后台派发通道】端到端钉死该契约：
    // exit 非零 + stderr 含 dispatch_cwd_not_found 与解析后的必缺路径 +
    // run-dir 零 run transcript（早于任何 transcript 写入、零 fork）。
    const bg = spawnSync(process.execPath, [
      "src/cli.js", "run", "researcher",
      "--prompt", "x",
      "--background",
      "--registry", fixtureRegistry,
      "--run-dir", bgRunDir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 15000 });
    assert.notEqual(bg.status, 0, "必缺 cwd 的后台派发必须 exit 非零");
    assert.match(bg.stderr, /dispatch_cwd_not_found/, "stderr 含闭集 reason code");
    assert.match(bg.stderr, /dispatch working directory does not exist/, "stderr 含 typed 拒绝文案");
    assert.ok(bg.stderr.includes(resolve(badCwd)),
      `stderr 含解析后的必缺路径，实际：${bg.stderr}`);
    assert.doesNotMatch(bg.stderr, /node\.exe ENOENT/, "不再出现归咎可执行文件的误导性 spawn ENOENT");
    const leaked = existsSync(bgRunDir)
      ? readdirSync(bgRunDir).filter((f) => f.endsWith(".jsonl"))
      : [];
    assert.equal(leaked.length, 0, "被拒派发零 transcript（run-dir 甚至未创建）");
  } finally {
    rmrfRetry(dir);
  }
});

test("run --background: malformed --scorecard-rules fail-fast，不返回 ghost runId", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bg-bad-scorecard-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_low: { backend: "claude-code", binary: "/nope", cwd: dir } },
    }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      "src/cli.js", "run", "coder_low",
      "--prompt", "x",
      "--background",
      "--registry", registryPath,
      "--run-dir", runDir,
      "--scorecard-rules", "{bad json",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });

    assert.notEqual(result.status, 0, "malformed scorecard rules must fail in the visible CLI process");
    assert.doesNotMatch(result.stdout, /"runId"/, "CLI must not print a runId for an invocation it refused");
    assert.match(result.stderr, /scorecard-rules|JSON/i, "stderr should explain scorecard JSON parsing failure");
  } finally {
    rmrfRetry(dir);
  }
});

test("wao doctor: OAuth 登录态 + provider-wrapped claude-code worker 给 WARN", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-oauth-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "oauth-token" },
    }));
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        researcher: {
          backend: "claude-code",
          provider: {
            baseUrl: "https://api.deepseek.com/anthropic",
            apiKeyEnv: "DEEPSEEK_API_KEY",
            model: "deepseek-v4-flash",
          },
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
      env: { ...process.env, HOME: home, USERPROFILE: home, DEEPSEEK_API_KEY: "provider-key" },
      timeout: 10000,
    });
    const parsed = JSON.parse(result.stdout);
    const warn = parsed.checks.find((c) => c.name === "claude_oauth_provider_workers");
    assert.ok(warn, "doctor 应报告 OAuth + provider worker 组合风险");
    assert.equal(warn.pass, true, "OAuth provider warning 不应让 doctor FAIL");
    assert.equal(warn.level, "warn");
    assert.match(warn.detail, /researcher/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wao doctor: auditor-only claude-code OAuth 不触发 provider worker WARN", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-auditor-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "oauth-token" },
    }));
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        auditor: {
          backend: "claude-code",
          model: { id: "claude-opus-4-8" },
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
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 10000,
    });
    const parsed = JSON.parse(result.stdout);
    assert.ok(!parsed.checks.some((c) => c.name === "claude_oauth_provider_workers"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TD-107: wao doctor 的 verdict 会被与本组测试无关的环境检查污染——provider key
// （ZHIPU/DEEPSEEK/KIMI_API_KEY，本机密钥，干净检出里没有）与本机 gitignored
// config/agents.json（registry_loads）。这几个测试只验证 wao_init / parse_smoke /
// invocation_method 本身，不应耦合本机密钥/配置。注入 dummy key + 指向 tracked
// synthetic registry（test/fixtures/agents.six.json），把 verdict 隔离到被测检查项。
// 不改产品语义——doctor 仍是 preflight 体检；只是测试不再要求真实密钥/本机配置。
// R5-B scoped 后防护意图不变：dummy key 让 scoped key 检查在进程 env 命中，
// 不触发 Windows User 作用域读取（慢且耦合本机注册表）。
const DOCTOR_REGISTRY = "test/fixtures/agents.six.json";
function doctorSpawnEnv() {
  return {
    ...process.env,
    ZHIPU_API_KEY: process.env.ZHIPU_API_KEY || "td107-test-key",
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "td107-test-key",
    KIMI_API_KEY: process.env.KIMI_API_KEY || "td107-test-key",
  };
}

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

test("TD-72 延伸: doctor 报告 invocation_method（info 级，告知 WAO 故意不进 PATH）", () => {
  // codex 实测 friction：把"PATH 里没有 wao"误读成安装缺失。其实是 v22 约束的刻意设计。
  // doctor 主动告知正确调用方式，堵住认知缺口——且 info 级不计入 HEALTHY 判定。
  const dir = mkdtempSync(join(tmpdir(), "wao-invok-"));
  try {
    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--cwd", dir,
      "--registry", DOCTOR_REGISTRY,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: doctorSpawnEnv(), timeout: 10000 });
    const parsed = JSON.parse(result.stdout);
    const inv = parsed.checks.find((c) => c.name === "invocation_method");
    assert.ok(inv, "doctor 应有 invocation_method info 项");
    assert.equal(inv.pass, true);
    assert.equal(inv.level, "info", "invocation_method 是 info 级，不是健康检查");
    assert.match(inv.detail, /npm run cli/, "应告知用 npm run cli 调");
    assert.match(inv.detail, /不进 PATH|不是安装缺失/, "应明示不进 PATH 是设计非缺失");
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
    for (const slot of ["state", "decisions", "pipeline", "handoff", "runs"]) {
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
    for (const cli of ["claude", "codex", "kimi", "opencode"]) {
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
          backend: "claude-code",
          provider: { baseUrl: "https://example.invalid/anthropic", apiKeyEnv: "WAO_TEST_NO_SUCH_KEY_R5B" },
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
    // scoped：未声明的 key 不得被检查（不写死三连）
    assert.ok(!parsed.checks.some((c) => c.name === "key_ZHIPU_API_KEY" || c.name === "key_DEEPSEEK_API_KEY"),
      "未声明的 provider key 不得被检查（scoped 收窄）");
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
          backend: "claude-code",
          provider: { baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "KIMI_API_KEY" },
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
    // claude-code wrapper 声明的 KIMI_API_KEY 是该 worker 真正需要的 env，必须照常检查
    // （进程 env 已注入 fake-kimi-key → OK）。有真实检查在场时不再叠同名 INFO 说明项。
    assert.equal(kimiChecks.length, 1, "wrapper 声明的 KIMI_API_KEY 恰一条真实检查（无同名 INFO 叠加）");
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
    for (const cli of ["claude", "codex", "kimi", "opencode"]) {
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
// （wao_init WARN 不混入断言）；HOME/USERPROFILE 指向空目录隔离本机 OAuth 凭据
// （claude_oauth_provider_workers WARN 面）；dummy key 沿 TD-107 doctorSpawnEnv。
// CLI 探测沿既有套件假设（claude/kimi CLI 在 PATH——与本文件其它 doctor 测试一致）。
function makeDoctorPanelFixture(name, agents) {
  const dir = mkdtempSync(join(tmpdir(), name));
  spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }, null, 2), "utf8");
  return { dir, registryPath };
}

function doctorPanelRun(dir, registryPath) {
  return spawnSync(process.execPath, ["src/cli.js", "wao", "doctor",
    "--registry", registryPath, "--cwd", dir, "--format", "json"],
    { cwd: process.cwd(), encoding: "utf8",
      env: { ...doctorSpawnEnv(), HOME: dir, USERPROFILE: dir }, timeout: 20000 });
}

test("R9-C C-3: doctor 三席齐备且含对抗席 → panel_readiness 静默（无条目）", () => {
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-panel-silent-", {
    coder_hq: { backend: "claude-code", provider: { baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.2" }, cwd: "." },
    coder_mm: { backend: "claude-code", provider: { baseUrl: "https://api.moonshot.cn/anthropic", apiKeyEnv: "KIMI_API_KEY" }, model: { id: "kimi-k3" }, cwd: "." },
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
    coder_hq: { backend: "claude-code", provider: { baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.2" }, cwd: "." },
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
    coder_dsh: { backend: "deepseek-harness", model: { id: "deepseek-v4-pro" }, cwd: "." },
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
    assert.match(panel.detail, /探测未知（不计入可用）：coder_dsh/,
      "C-12：探测未知行如实展示（deepseek-harness 无 CLI 映射 → unknown）");
    // deepseek-harness 触发 backend_map WARN → verdict DEGRADED，但无 FAIL：
    // WARN/INFO 都不改 advisory 退出码。
    assert.equal(r.status, 0, "WARN/INFO 面不改退出码（无 FAIL）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R9-C C-1.4（auditor 实跑病灶）: 零对抗席 three_seat → doctor 不静默，附补配提示", () => {
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-panel-noadv-", {
    coder_hq: { backend: "claude-code", provider: { baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.2" }, cwd: "." },
    coder_low: { backend: "claude-code", provider: { baseUrl: "https://api.deepseek.com/anthropic", apiKeyEnv: "DEEPSEEK_API_KEY" }, model: { id: "deepseek-v4-flash" }, cwd: "." },
  });
  try {
    const r = doctorPanelRun(dir, registryPath);
    const parsed = JSON.parse(r.stdout);
    const panel = parsed.checks.find((c) => c.name === "panel_readiness");
    assert.ok(panel, "≥2 席位候选但 0 对抗席 → 必须打印（消除假全清——实跑病灶）");
    assert.equal(panel.status, "info");
    assert.match(panel.detail, /物理上可配三席，但无对抗席候选（auditor\/coder_mm）/,
      "C-1 裁定文案：无对抗席候选提示行");
    assert.match(panel.detail, /两席分配语义要求对抗视角/, "0019/0023 分配语义引用");
    assert.match(panel.detail, /coder_hq、coder_low/, "席位候选点名");
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R9-C C-1（auditor 实跑病灶）: researcher+coder_hq registry → 两席打印，researcher 不进可用席位", () => {
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-panel-researcher-", {
    researcher: { backend: "claude-code", provider: { baseUrl: "https://api.deepseek.com/anthropic", apiKeyEnv: "DEEPSEEK_API_KEY" }, model: { id: "deepseek-v4-pro" }, cwd: "." },
    coder_hq: { backend: "claude-code", provider: { baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.2" }, cwd: "." },
  });
  try {
    const r = doctorPanelRun(dir, registryPath);
    const parsed = JSON.parse(r.stdout);
    const panel = parsed.checks.find((c) => c.name === "panel_readiness");
    assert.ok(panel, "researcher（ready 但非席位）只剩 1 名席位候选 → 两席必须打印（旧代码此处假全清）");
    assert.match(panel.detail, /仅 1 名可用（coder_hq）/, "可用席位只点名 coder_hq");
    assert.ok(!panel.detail.includes("researcher"), "非席位角色不进可用副审叙事");
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R9-C C-16: 单 worker registry → 空转事实为主句直给（先建议后撤回的话术废除）", () => {
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-panel-solo-", {
    coder_hq: { backend: "claude-code", provider: { baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.2" }, cwd: "." },
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

test("R10-B B-1: doctor declared seatRole 优先——my_reviewer 显式对抗席使三席静默；未声明同 id 回退非席位", () => {
  // 显式对抗席 + 实现席：三席齐备且含对抗席 → 静默。若 declared 被忽略，
  // my_reviewer 回退非席位 → 只剩 coder_hq → 两席必打印（红测语义）。
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-panel-declared-", {
    my_reviewer: { backend: "claude-code", provider: { baseUrl: "https://api.deepseek.com/anthropic", apiKeyEnv: "DEEPSEEK_API_KEY" }, model: { id: "deepseek-v4-pro" }, cwd: ".", seatRole: "adversarial" },
    coder_hq: { backend: "claude-code", provider: { baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.2" }, cwd: ".", seatRole: "implementation" },
  });
  try {
    const r = doctorPanelRun(dir, registryPath);
    const parsed = JSON.parse(r.stdout);
    assert.ok(!parsed.checks.some((c) => c.name === "panel_readiness"),
      "declared 对抗席计入 → 三席齐备且含对抗席 → 静默（无 panel_readiness 条目）");
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 未声明的同 id → 回退非席位：只剩 coder_hq → 两席打印（既有 fallback 行为）。
  const undecl = makeDoctorPanelFixture("wao-doctor-panel-undeclared-", {
    my_reviewer: { backend: "claude-code", provider: { baseUrl: "https://api.deepseek.com/anthropic", apiKeyEnv: "DEEPSEEK_API_KEY" }, model: { id: "deepseek-v4-pro" }, cwd: "." },
    coder_hq: { backend: "claude-code", provider: { baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.2" }, cwd: "." },
  });
  try {
    const r = doctorPanelRun(undecl.dir, undecl.registryPath);
    const parsed = JSON.parse(r.stdout);
    const panel = parsed.checks.find((c) => c.name === "panel_readiness");
    assert.ok(panel, "未声明 my_reviewer 回退非席位 → 只剩 1 名席位候选 → 打印");
    assert.match(panel.detail, /仅 1 名可用（coder_hq）/, "可用席位只点名 coder_hq（my_reviewer 不进）");
    assert.equal(r.status, 0);
  } finally {
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
// 环境类检查的地盘是 doctor（SKILL 契约：registry validate = static schema，
// 存在性是机器状态不进 validate）。判定语义与 R7 assertExistingDispatchCwd
// 完全一致（同一 runManager SSOT 探针：path.resolve 后 statSync 目录判定）；
// 能力收窄与 R7 两层派发门对称（本地进程式 backend 查，HTTP serve 豁免）。
// R8-C C-8 起健康面唯一条目：cwd === "." 的 worker 出 INFO（静默落点提示，
// 不计 DEGRADED）；其余健康面零条目（budget_* 同款惯例）。
test("R8-2: doctor registry cwd——坏 cwd 给 WARN（DEGRADED，exit 0）+ run: 子句；\".\" 给 INFO 不给 WARN；HTTP backend 零条目", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-cwd-"));
  try {
    const badCwd = join(dir, "no-such-project");
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        // 本地进程式 backend + 不存在的 cwd → 应 WARN（R8-2 主面）
        researcher: { backend: "claude-code", cwd: badCwd },
        // "." 解析为发起派发的进程的 cwd（CLI 通道=敲命令时所在目录；MCP 通道
        // =MCP 服务进程的 cwd，由 host 决定），恒存在 → 不 WARN；R8-C C-8 起
        // 出一条 INFO 静默落点提示（R8-1 后模板值即 "."）
        coder_low: { backend: "claude-code", cwd: "." },
        // HTTP serve backend：cwd 是远端目录提示，与派发层能力豁免对称
        // （CE-13/RCE-6 钉死的不拒面）→ doctor 不得更严，不产生条目
        ghost_serve: {
          backend: "opencode-serve",
          serveUrl: "http://127.0.0.1:4297",
          cwd: badCwd,
          tokenBudget: 5000000,
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
      "仅本地进程式 worker 出条目：bad cwd=WARN、\".\"=INFO；opencode-serve（远端提示）零条目",
    );
    assert.ok(!parsed.checks.some((c) => c.name === "cwd_ghost_serve"),
      "HTTP serve backend 不得出 cwd_* 条目（CE-13/RCE-6 不拒面对称）");

    assert.match(parsed.verdict, /^DEGRADED（\d+ warn）/, "WARN → DEGRADED");
    assert.equal(result.status, 0, "仅 WARN + INFO → exit 0（advisory 非门禁，INFO 不计 DEGRADED）");
  } finally {
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
    for (const slot of ["state", "decisions", "pipeline", "handoff", "runs"]) {
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

// ── TD-77 子项 A（collect 重建非 message 证据）─────────────────────────────
// 进程型 worker 崩溃时常无最终 message，但 transcript 里有 command/tool_use/
// file_written 等证据事件。旧 collect 只重建 kind==="message" → data:[]，
// 让 Lead 验收只能读原始 transcript。修复后 collect 重建所有 run.event kind。
//
// session.created 带 backendSessionId=proc_<pid> 且无 serveUrl → 走进程分支。
function writeProcRunTranscript(dir, runId, runEventLines) {
  writeFileSync(join(dir, `${runId}.jsonl`),
    JSON.stringify({ type: "run.submitted", agentId: "researcher", ts: "2026-06-28T20:33:52.000Z" }) + "\n" +
    JSON.stringify({ type: "session.created", backend: "process", backendSessionId: "proc_4242" }) + "\n" +
    JSON.stringify({ type: "run.started", backend: "claude-code", ts: "2026-06-28T20:33:53.000Z" }) + "\n" +
    runEventLines +
    JSON.stringify({ type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-06-28T20:35:00.000Z" }) + "\n" +
    JSON.stringify({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-28T20:35:00.000Z" }) + "\n");
}

test("TD-77A: 失败 run 无最终 message 但有证据事件 → collect 重建非空（含各 kind）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-collect-fail-"));
  try {
    // 模拟 codex e2e run_20260628203352049lf1n0l：崩前有 tool_use/tool_result/
    // file_written，但无最终 assistant message → 旧 collect 返回 data:[]。
    writeProcRunTranscript(dir, "run_collect_fail",
      JSON.stringify({ type: "run.event", kind: "command", command: "rg TODO", exitCode: 0, ts: "2026-06-28T20:34:05.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "tool_use", tool: "Read", input: { file_path: "src/app.py" }, ts: "2026-06-28T20:34:10.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "tool_result", tool: "Read", output: "def main():...", isError: false, ts: "2026-06-28T20:34:11.000Z" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "file_written", path: "D:/proj/report.md", ts: "2026-06-28T20:34:30.000Z" }) + "\n");
    const out = await captureLog(async () => {
      await collectCommand(["run_collect_fail", "--run-dir", dir], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.reconstructed, true, "进程型 run 走重建路径");
    assert.equal(parsed.backend, "process");
    assert.ok(Array.isArray(parsed.data) && parsed.data.length > 0,
      "失败 run 有证据事件 → data 非空（旧实现返回 []）");
    // 重建应含 command/tool_use/tool_result/file_written 各 kind
    const kinds = parsed.data.map((e) => e.kind);
    assert.ok(kinds.includes("command"), "data 含 command");
    assert.ok(kinds.includes("tool_use"), "data 含 tool_use");
    assert.ok(kinds.includes("tool_result"), "data 含 tool_result");
    assert.ok(kinds.includes("file_written"), "data 含 file_written");
    // tool_use 重建应带 tool + input 字段
    const tu = parsed.data.find((e) => e.kind === "tool_use");
    assert.equal(tu.tool, "Read");
    assert.deepEqual(tu.input, { file_path: "src/app.py" });
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-77A 回归: 纯 message 成功 run → collect 仍重建 message（不破坏原行为）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-collect-msg-"));
  try {
    writeProcRunTranscript(dir, "run_collect_msg",
      JSON.stringify({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }], ts: "2026-06-28T20:34:20.000Z" }) + "\n");
    const out = await captureLog(async () => {
      await collectCommand(["run_collect_msg", "--run-dir", dir], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.reconstructed, true);
    assert.ok(parsed.data.length > 0, "有 message → data 非空");
    const msgs = parsed.data.filter((e) => e.kind === "message");
    assert.ok(msgs.length > 0, "data 含 message kind");
    assert.equal(msgs[0].role, "assistant");
    assert.deepEqual(msgs[0].parts, [{ type: "text", text: "done" }]);
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-77A: 空 run（无任何 run.event）→ data:[] 不抛", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-collect-empty-"));
  try {
    // 只有编排事件，无 worker 产出事件
    writeProcRunTranscript(dir, "run_collect_empty", "");
    const out = await captureLog(async () => {
      await collectCommand(["run_collect_empty", "--run-dir", dir], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.reconstructed, true);
    assert.deepEqual(parsed.data, [], "无 run.event → data:[]");
  } finally {
    rmrfRetry(dir);
  }
});

// ===== M11-4 B4: CLI collect --cursor parity + audit append =====

// A process transcript with N assistant messages for CLI continuation tests.
function writeM11_4CliTranscript(dir, runId, messageBodies) {
  const lines = [
    JSON.stringify({ type: "run.submitted", agentId: "researcher", ts: "2026-07-22T00:00:00.000Z" }),
    JSON.stringify({ type: "session.created", backend: "process", backendSessionId: "proc_m114_cli", runId, agentId: "researcher" }),
    JSON.stringify({ type: "run.started", backend: "claude-code", ts: "2026-07-22T00:00:01.000Z", runId, agentId: "researcher" }),
  ];
  messageBodies.forEach((body, i) => {
    lines.push(JSON.stringify({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text: body }],
      ts: `2026-07-22T00:00:${10 + i}.000Z`, runId, agentId: "researcher",
    }));
  });
  lines.push(JSON.stringify({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId, agentId: "researcher" }));
  writeFileSync(join(dir, `${runId}.jsonl`), lines.map((l) => l + "\n").join(""), "utf8");
}

// ---------------------------------------------------------------------
// M11-4-B4-01: default `collect <runId>` stays byte-compatible (raw data
// shape, no nextCursor pollution). The new --cursor entry is opt-in.
// ---------------------------------------------------------------------
test("M11-4-B4-01: default collect stays byte-compatible (raw data, no cursor field)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b4-01-"));
  try {
    writeM11_4CliTranscript(dir, "run_cli_default", ["one", "two"]);
    const out = await captureLog(async () => {
      await collectCommand(["run_cli_default", "--run-dir", dir], { runDir: dir });
    });
    const parsed = JSON.parse(out);
    // Existing raw ops surface preserved.
    assert.equal(parsed.reconstructed, true);
    assert.equal(parsed.backend, "process");
    assert.ok(Array.isArray(parsed.data));
    assert.equal(parsed.data.length, 2);
    // No safe-projection fields leak into the default ops output.
    assert.equal(parsed.nextCursor, undefined, "default collect has no nextCursor");
    assert.equal(parsed.messages, undefined, "default collect has no messages array");
    assert.equal(parsed.evidenceCounts, undefined, "default collect has no evidenceCounts");
  } finally {
    rmrfRetry(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B4-02: `collect <runId> --cursor <token>` delegates to the shared
// safe projection (MCP-parity JSON output with nextCursor).
// ---------------------------------------------------------------------
test("M11-4-B4-02: collect --cursor delegates to shared safe projection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b4-02-"));
  try {
    const bodies = [];
    for (let i = 0; i < 12; i += 1) bodies.push(`cli-body-${i}`);
    writeM11_4CliTranscript(dir, "run_cli_cursor", bodies);

    // Page 1 WITHOUT cursor → projection-mode first page.
    let out = await captureLog(async () => {
      await collectCommand(["run_cli_cursor", "--run-dir", dir, "--format", "json"], { runDir: dir });
    });
    let parsed = JSON.parse(out);
    assert.ok(parsed.messages, "--format json yields projection shape");
    assert.equal(parsed.messages.length, 8, "page 1 caps at 8");
    assert.ok(parsed.nextCursor, "page 1 has next cursor");
    assert.equal(parsed.runId, "run_cli_cursor");
    assert.equal(parsed.backend, "process");
    assert.ok(parsed.evidenceCounts);

    // Page 2 WITH cursor.
    const cursor = parsed.nextCursor;
    out = await captureLog(async () => {
      await collectCommand(["run_cli_cursor", "--cursor", cursor, "--run-dir", dir, "--format", "json"], { runDir: dir });
    });
    parsed = JSON.parse(out);
    assert.equal(parsed.messages.length, 4, "page 2 returns the remaining 4");
    assert.equal(parsed.nextCursor, null, "page 2 is terminal");
  } finally {
    rmrfRetry(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B4-03: CLI continuation audit — each successful page appends exactly
// one messages.collected; invalid cursor appends zero. Audit event does not
// store cursor or text.
// ---------------------------------------------------------------------
test("M11-4-B4-03: CLI continuation audit appends one per page, zero on invalid cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b4-03-"));
  try {
    const bodies = [];
    for (let i = 0; i < 12; i += 1) bodies.push(`audit-${i}`);
    writeM11_4CliTranscript(dir, "run_cli_audit", bodies);
    const tpath = join(dir, "run_cli_audit.jsonl");

    // Page 1
    let out = await captureLog(async () => {
      await collectCommand(["run_cli_audit", "--run-dir", dir, "--format", "json"], { runDir: dir });
    });
    const page1 = JSON.parse(out);
    // Page 2
    await captureLog(async () => {
      await collectCommand(["run_cli_audit", "--cursor", page1.nextCursor, "--run-dir", dir, "--format", "json"], { runDir: dir });
    });
    // Invalid cursor — must NOT append.
    await captureLog(async () => {
      try {
        await collectCommand(["run_cli_audit", "--cursor", "not!base64url", "--run-dir", dir, "--format", "json"], { runDir: dir });
      } catch { /* expected */ }
    });

    const events = readFileSync(tpath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const audits = events.filter((e) => e.type === "messages.collected");
    assert.equal(audits.length, 2, "exactly 2 audits for 2 successful pages");
    // Audit must not carry cursor or text.
    for (const a of audits) {
      const dumped = JSON.stringify(a);
      assert.ok(!/nextCursor|cursor token/i.test(dumped), "audit has no cursor");
      assert.ok(!/"text"\s*:/.test(dumped), "audit has no message text");
    }
    // Terminal unchanged.
    const states = events.filter((e) => e.type === "run.state_change");
    assert.equal(states.at(-1).to, "completed", "terminal unchanged");
  } finally {
    rmrfRetry(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B4-04: CLI continuation with --cursor produces output that is
// deep-equal to MCP structuredContent for the same run + page.
// ---------------------------------------------------------------------
test("M11-4-B4-04: CLI --cursor output deep-equals MCP structuredContent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b4-04-"));
  try {
    const bodies = [];
    for (let i = 0; i < 12; i += 1) bodies.push(`parity-${i}`);
    writeM11_4CliTranscript(dir, "run_cli_parity", bodies);

    // CLI page 1.
    const cliOut = await captureLog(async () => {
      await collectCommand(["run_cli_parity", "--run-dir", dir, "--format", "json"], { runDir: dir });
    });
    const cliPage1 = JSON.parse(cliOut);

    // MCP page 1 over InMemoryTransport (separate run dir to avoid double-append
    // polluting the CLI's transcript). We build a second identical fixture.
    const dir2 = mkdtempSync(join(tmpdir(), "wao-m114-b4-04b-"));
    const runDir2 = join(dir2, "runs");
    mkdirSync(runDir2, { recursive: true });
    writeM11_4CliTranscript(runDir2, "run_cli_parity", bodies);

    const { createWaoMcpServer } = await import("../../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createWaoMcpServer({ registryPath: "/server/r.json", runDir: runDir2 });
    const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_cli_parity" } });
      const mcpPage1 = res.structuredContent;
      // Deep semantic equality: same field set, same message texts, same
      // evidenceCounts, same itemCount, same truncated. nextCursor tokens
      // differ in literal (different snapshot reads) but both must be
      // non-null base64url ≤192.
      assert.deepEqual(cliPage1.messages, mcpPage1.messages, "messages deepEqual");
      assert.deepEqual(cliPage1.evidenceCounts, mcpPage1.evidenceCounts, "evidenceCounts deepEqual");
      assert.equal(cliPage1.itemCount, mcpPage1.itemCount);
      assert.equal(cliPage1.backend, mcpPage1.backend);
      assert.equal(cliPage1.reconstructed, mcpPage1.reconstructed);
      assert.equal(cliPage1.truncated, mcpPage1.truncated);
      assert.equal(cliPage1.runId, mcpPage1.runId);
      assert.ok(cliPage1.nextCursor && mcpPage1.nextCursor);
      assert.match(cliPage1.nextCursor, /^[A-Za-z0-9_-]+$/);
      assert.match(mcpPage1.nextCursor, /^[A-Za-z0-9_-]+$/);
    } finally {
      await client.close();
      await server.close();
      rmrfRetry(dir2);
    }
  } finally {
    rmrfRetry(dir);
  }
});

test("runs scorecard --format json: 无规则与提前失败都输出三态 JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-scorecard-json-states-"));
  try {
    writeFileSync(join(dir, "run_no_rules.jsonl"), [
      JSON.stringify({ type: "run.started", scorecardConfigured: false }),
      JSON.stringify({ type: "run.error", error: "boom" }),
    ].join("\n") + "\n");
    writeFileSync(join(dir, "run_before_gate.jsonl"), [
      JSON.stringify({ type: "run.started", scorecardConfigured: true }),
      JSON.stringify({ type: "run.error", error: "provider auth failed" }),
      JSON.stringify({ type: "run.state_change", to: "failed" }),
    ].join("\n") + "\n");

    const noRules = spawnSync(process.execPath, [
      "src/cli.js", "runs", "scorecard", "run_no_rules",
      "--run-dir", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(noRules.status, 0);
    assert.deepEqual(JSON.parse(noRules.stdout), {
      runId: "run_no_rules",
      scorecard: null,
      reason: "no_rules",
    });

    const beforeGate = spawnSync(process.execPath, [
      "src/cli.js", "runs", "scorecard", "run_before_gate",
      "--run-dir", dir,
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(beforeGate.status, 0);
    const parsed = JSON.parse(beforeGate.stdout);
    assert.equal(parsed.runId, "run_before_gate");
    assert.equal(parsed.scorecard, null);
    assert.equal(parsed.reason, "failed_before_scorecard");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TD-53 守卫：run --format json 必须带 scorecard 字段（与 text 格式对等）。
// 首装 e2e 摩擦日志 F3：原 json 分支 early-return 在 scorecard 注入之前，丢字段。
// 用 mock claude-code 子进程 + 注入 backend/readRegistry 跑完一次 completed run，
// 断言 json 输出解析后含 scorecard（scorecard.warn 默认模式下 completed run 必落 scorecard.checked）。
test("run --format json: 带 scorecard 字段（与 text 对等，TD-53）", async () => {
  const { ClaudeCodeBackend } = await import("../../src/backends/claudeCode.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-f3-json-sc-"));
  try {
    // mock 子进程：输出 claude 风格 JSONL（assistant text + result success）后退出
    const claudeLines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","subtype":"success","is_error":false}',
    ];
    const payload = Buffer.from(claudeLines.join("\n")).toString("base64");
    const script = `process.stdout.write(Buffer.from("${payload}","base64").toString("utf8")+"\\n");`;
    const backend = new ClaudeCodeBackend({ buildArgs: () => ["-e", script] });
    backend.defaultBinary = () => process.execPath;

    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        return { id, backend: "claude-code", cwd: dir, ...overrides };
      },
      listAgents() { return []; },
    });
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
      timeout: 5000, retries: 0, backendFor: () => backend, readRegistry,
    };

    const out = await captureLog(async () => {
      await runCommand(["claude_worker", "--prompt", "hi", "--format", "json", "--run-dir", dir], config);
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.completed, true, "mock run 应 completed");
    assert.ok(parsed.scorecard, "--format json 必须带 scorecard 字段（TD-53：原 json 分支丢此字段）");
    assert.ok(typeof parsed.scorecard.passed === "boolean", "scorecard.passed 必须是 boolean");
    assert.ok(Array.isArray(parsed.scorecard.checks), "scorecard.checks 必须是数组");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 对照测试：run --format text 同样带 scorecard（renderRunSummary 输出 scorecard 卡片）。
// 确认两格式对等——任一回归都会被这两个 test 捕到。
test("run --format text: 带 scorecard 卡片（与 json 对等，TD-53 对照）", async () => {
  const { ClaudeCodeBackend } = await import("../../src/backends/claudeCode.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-f3-text-sc-"));
  try {
    const claudeLines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","subtype":"success","is_error":false}',
    ];
    const payload = Buffer.from(claudeLines.join("\n")).toString("base64");
    const script = `process.stdout.write(Buffer.from("${payload}","base64").toString("utf8")+"\\n");`;
    const backend = new ClaudeCodeBackend({ buildArgs: () => ["-e", script] });
    backend.defaultBinary = () => process.execPath;

    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        return { id, backend: "claude-code", cwd: dir, ...overrides };
      },
      listAgents() { return []; },
    });
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
      timeout: 5000, retries: 0, backendFor: () => backend, readRegistry,
    };

    const out = await captureLog(async () => {
      await runCommand(["claude_worker", "--prompt", "hi", "--run-dir", dir], config);
    });
    assert.match(out, /scorecard/, "text 格式必须渲染 scorecard 卡片");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round2-AB：CLI friction #1/#2/#3 处置（friction-log 2026-08-15）
//
// #1 `run status <runId>` 类笔误：agentId 位置误填顶层命令名 → did-you-mean。
// #2 `run --help` 无用法输出 → RUN_USAGE_TEXT 用法页（--help 须为 run 后第一个参数）。
// #3 delivery spec 带 {"delivery": ...} 外层包装报错难懂 → catch-and-annotate INNER 提示。
// ---------------------------------------------------------------------------

test("A-1: run <顶层命令名> 不带 prompt → did-you-mean 提示（friction #1）", async () => {
  await assert.rejects(
    () => runCommand(["status", "run_x"], {}),
    (e) =>
      e.message.startsWith("Provide --prompt or --prompt-file") &&
      e.message.includes("did you mean") &&
      e.message.includes("status"),
  );
});

test("A-1: 普通 agentId 不带 prompt 仍走原拒绝路径（消息无 did-you-mean）", async () => {
  await assert.rejects(
    () => runCommand(["coder_low"], {}),
    (e) => {
      // 验收 P1（coder_hq）：钉住原错误头——loadPrompt 文案被改时本反例也红。
      assert.ok(e.message.startsWith("Provide --prompt or --prompt-file"));
      assert.doesNotMatch(e.message, /did you mean/);
      return true;
    },
  );
});

test("A-1/TD-120: COMMAND_NAMES 每个成员在 HELP_TEXT 有行锚定条目（防子串误报）", () => {
  // 行锚定 ^  + name(\s|$)：HELP_TEXT 每行以两个空格开头。防 "runs 含 run"
  // 子串误报——裸 includes 会让 "runs" 行满足 "run"。
  for (const name of COMMAND_NAMES) {
    assert.ok(
      new RegExp("^  " + name + "(\\s|$)", "m").test(HELP_TEXT),
      `HELP_TEXT must contain a line starting with two spaces + "${name}"`,
    );
  }
});

test("A-2: run --help 进程内打印用法页（不抛，含 --delivery-spec-file 与 INNER）", async () => {
  const out = await captureLog(() => runCommand(["--help"], {}));
  assert.match(out, /--delivery-spec-file/, "用法页必须列出 --delivery-spec-file flag");
  assert.match(out, /INNER/, "用法页必须说明 spec 文件内容是 INNER delivery 对象");
  // Round 4 Bundle B 联动：--read-only 旗标必须进用法页（且带 honest 语义说明）。
  assert.match(out, /--read-only/, "用法页必须列出 --read-only flag");
  assert.match(out, /never a gate/, "用法页必须说明 --read-only 是 advisory 观察非门");
});

test("A-2: run --help 子进程 exit 0 且 stdout 含用法（execSync 非零退出即 throw）", () => {
  const out = runCliOnPathNode("run --help");
  assert.match(out, /--delivery-spec-file/, "run --help 必须打印 --delivery-spec-file flag");
  assert.match(out, /--read-only/, "run --help 必须打印 --read-only flag");
});

test("A-3: delivery spec 带 {\"delivery\":...} 外层包装 → SSOT 拒绝 + INNER delivery object 提示", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dspec-wrap-"));
  try {
    const f = join(dir, "spec.json");
    writeFileSync(f, JSON.stringify({
      delivery: { mode: "git_commit_v1", allowedPaths: ["x"], verificationCommands: ["true"] },
    }), "utf8");
    // 该路径在 loadDeliverySpec（registry/newRunManager 副作用之前）抛——纯检查。
    await assert.rejects(
      () => runCommand(["coder_low", "--delivery-spec-file", f, "--isolate"], {}),
      (e) => {
        assert.match(e.message, /delivery\.mode must be "git_commit_v1"/, "SSOT 错误原样保留");
        assert.match(e.message, /INNER delivery object/, "外层包装形状必须追加 INNER 提示");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A-3: delivery spec 无外层包装的其它形状 → 仅 SSOT 错误（无 INNER 提示，证明 hint 条件触发）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dspec-plain-"));
  try {
    const f = join(dir, "spec.json");
    writeFileSync(f, JSON.stringify({ foo: 1 }), "utf8");
    await assert.rejects(
      () => runCommand(["coder_low", "--delivery-spec-file", f, "--isolate"], {}),
      (e) => {
        assert.match(e.message, /delivery\.mode must be "git_commit_v1"/, "同一 SSOT 拒绝");
        assert.doesNotMatch(e.message, /INNER/, "非包装形状不得追加 INNER 提示");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// R5 审计 P0-1：agents.json 存在但解析失败 ≠ 正常初态——必须 WARN（→ DEGRADED，
// exit 0），不得与健康态同列 INFO 让 verdict 说 HEALTHY（假绿灯）。同时钉住
// registry_loads 在 missing/parse-ok/parse-fail 三条路径恒在场（P2-1 形状稳定）。
test("R5 P0-1: registry 解析失败 → WARN（DEGRADED）而非 INFO（HEALTHY 假绿灯）；registry_loads 恒在场", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-parse-fail-"));
  try {
    const brokenPath = join(dir, "agents-broken.json");
    writeFileSync(brokenPath, "{ not valid json !!", "utf8");
    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor", "--registry", brokenPath, "--cwd", dir, "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 10000 });
    const parsed = JSON.parse(result.stdout);
    const loads = parsed.checks.find((c) => c.name === "registry_loads");
    assert.ok(loads, "parse 失败路径 registry_loads 必须在场");
    assert.equal(loads.status, "warn", "解析失败是'坏了'，至少 WARN");
    assert.match(loads.fix, /registry validate/, "WARN 应带 registry validate 修复提示");
    assert.match(parsed.verdict, /^DEGRADED（\d+ warn）/, "parse 失败 → DEGRADED 而非 HEALTHY（本目录无 .wao/，wao_init 未初始化同计 WARN）");
    assert.ok(!/HEALTHY（advisory/.test(parsed.verdict), "不得假绿灯");
    assert.equal(result.status, 0, "WARN 不致 exit 1（advisory）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R10-A（Owner 2026-08-17）：per-dispatch 模型覆盖（--model <modelId>）。
// 单次生效、不落注册表；只替换 registry model 的 .id（contextWindow 等
// 兄弟字段保留）。前台/后台两条路径都必须生效；两道硬互斥 fail-fast；
// 形状门对齐 canonicalAgentId 纪律（"--" 前缀会打断 runner 的 flag 解析）。
// ---------------------------------------------------------------------------

// R10-A 前台共用夹具：注入 backend（捕获 spawn 收到的合成 model）+ 原生 readRegistry。
function makeModelOverrideFixture(dir) {
  const spawnedModels = [];
  const fakeBackend = {
    validateAgentPolicy(agent) {
      assert.ok(agent.model && typeof agent.model.id === "string",
        "synthesized model reaches the ordinary policy validation surface");
    },
    async spawn(agent) {
      spawnedModels.push(agent.model);
      return {
        backend: "claude-code",
        backendSessionId: "s_r10a",
        messageId: "m_r10a",
        admittedSeq: 1,
        async *events() {
          yield { kind: "assistant", role: "assistant", parts: [{ type: "text", text: "done" }] };
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      return { id, backend: "claude-code", cwd: dir, model: { id: "glm-5.3", contextWindow: 1000000 }, ...overrides };
    },
    listAgents() { return []; },
  });
  const config = {
    registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
    timeout: 5000, retries: 0, backendFor: () => fakeBackend, readRegistry,
  };
  return { config, spawnedModels };
}

test("R10-A-CLI-1: run --model 前台 → start 收到合成 model（contextWindow 保留）+ run.started 含 modelOverride + 回显 effective model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r10a-fg-"));
  try {
    const { config, spawnedModels } = makeModelOverrideFixture(dir);
    const out = await captureLog(async () => {
      await runCommand([
        "claude_worker", "--prompt", "hi", "--run-dir", dir, "--model", "gpt-5.6-sol-xhigh",
      ], config);
    });
    // start 收到的（并传给 spawn 的）model：id 被替换、contextWindow 保留——
    // GLM [1m] 形状丢窗口在这里必须红。
    assert.deepEqual(spawnedModels, [{ id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 }],
      "synthesized policy: only .id replaced, siblings preserved");
    // 派发成功输出回显 effective model（打错的模型名立刻可见）。
    assert.match(out, /effective model: \{"id":"gpt-5\.6-sol-xhigh","contextWindow":1000000\}/,
      "text format echoes the effective model at dispatch success");
    // transcript 事实：run.started.model = 合成后策略 + 显式 modelOverride 字段。
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(files.length, 1, "one run transcript");
    const events = await readTranscript(join(dir, files[0]));
    const started = events.find((e) => e.type === "run.started");
    assert.deepEqual(started.model, { id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 },
      "run.started.model reflects the synthesized policy");
    assert.equal(started.modelOverride, "gpt-5.6-sol-xhigh",
      "run.started carries the explicit override fact (one-off vs registry change)");
  } finally {
    rmrfRetry(dir);
  }
});

test("R10-A-CLI-2: run --model --format json → 结构化 model 字段（无散行，输出保持可解析）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r10a-fg-json-"));
  try {
    const { config } = makeModelOverrideFixture(dir);
    const out = await captureLog(async () => {
      await runCommand([
        "claude_worker", "--prompt", "hi", "--run-dir", dir, "--format", "json", "--model", "gpt-5.6-sol-xhigh",
      ], config);
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.completed, true, "mock run 应 completed");
    assert.deepEqual(parsed.model, { id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 },
      "json format carries the structured effective model");
    assert.doesNotMatch(out, /^effective model:/m, "json 分支不打印散行（保持机器可解析）");
  } finally {
    rmrfRetry(dir);
  }
});

test("R10-A-CLI-3: 无 --model 的前台 run 字节不变（无回显行、无 model 字段、run.started 无 modelOverride）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r10a-fg-none-"));
  try {
    const { config } = makeModelOverrideFixture(dir);
    const out = await captureLog(async () => {
      await runCommand(["claude_worker", "--prompt", "hi", "--run-dir", dir], config);
    });
    assert.doesNotMatch(out, /effective model/, "无覆盖时无回显行");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const events = await readTranscript(join(dir, files[0]));
    const started = events.find((e) => e.type === "run.started");
    assert.equal("modelOverride" in started, false, "run.started payload 保持原形状");
    assert.deepEqual(started.model, { id: "glm-5.3", contextWindow: 1000000 }, "registry 原策略原样落盘");
  } finally {
    rmrfRetry(dir);
  }
});

test("R10-A-CLI-4: --model 形状门（空/布尔/-- 前缀/空白/超长）→ 固定文案 fail-fast", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r10a-gate-"));
  try {
    const { config } = makeModelOverrideFixture(dir);
    const badArgvs = [
      ["--model"],                       // 裸 flag → parseOptions 给 true
      ["--model", "--cwd"],              // 值位被下一个 flag 占据 → true
      ["--model", "--next-flag"],        // 同上（runner 会解析断裂的形状）
      ["--model", "has space"],          // 空白
      ["--model", "x".repeat(129)],      // 超长
    ];
    for (const extra of badArgvs) {
      await assert.rejects(
        () => runCommand(["claude_worker", "--prompt", "hi", "--run-dir", dir, ...extra], config),
        (e) => {
          assert.match(e.message, /--model must be a non-empty string of at most 128 characters/,
            `固定文案（${extra.join(" ")}）`);
          assert.match(e.message, /must not start with "--"/, "文案说明 -- 前缀规则");
          assert.doesNotMatch(e.message, /next-flag/, "不回显原值");
          return true;
        },
      );
    }
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".jsonl")), [], "零 transcript（全部在副作用前拒绝）");
  } finally {
    rmrfRetry(dir);
  }
});

test("R10-A-CLI-5: --model × --require-certified → 无条件互斥 fail-fast（闭集码文案）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r10a-cert-"));
  try {
    const { config } = makeModelOverrideFixture(dir);
    await assert.rejects(
      () => runCommand([
        "claude_worker", "--prompt", "hi", "--run-dir", dir,
        "--model", "glm-5.3", "--require-certified",
      ], config),
      (e) => {
        assert.match(e.message, /model_override_certified_conflict/, "闭集理由码");
        assert.match(e.message, /certification matrix is recorded per provider\+model/, "说明互斥理由");
        assert.match(e.message, /drop one of the two flags/i, "修复指引");
        return true;
      },
    );
    // 值感知放行被明确排除：即使 override 与 registry id 完全一致也拒（flag 存在即拒）。
    await assert.rejects(
      () => runCommand([
        "claude_worker", "--prompt", "hi", "--run-dir", dir,
        "--model", "glm-5.3", "--require-certified",
      ], config),
      /model_override_certified_conflict/,
    );
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".jsonl")), [], "零 transcript");
  } finally {
    rmrfRetry(dir);
  }
});

test("R10-A-CLI-6: spawn --model → 明确拒绝（--model 是 run 专属表面）", async () => {
  await assert.rejects(
    () => spawnCommand(["researcher", "--prompt", "hi", "--model", "glm-5.3"], {}),
    (e) => {
      assert.match(e.message, /--model is only supported on `run`, not `spawn`/);
      assert.match(e.message, /registry model policy/, "指引持久化模型应改注册表");
      return true;
    },
  );
});

test("R10-A-CLI-7: run --help 用法页含 --model（形状门 + 两道互斥 + 失败模式）", async () => {
  const out = await captureLog(() => runCommand(["--help"], {}));
  assert.match(out, /--model ID/, "flag 行存在");
  assert.match(out, /not\s+starting with "--"/, "形状门说明");
  assert.match(out, /mutually exclusive with --require-certified/, "认证互斥说明");
  assert.match(out, /mutually exclusive with.*provider-session reuse|provider-session reuse/, "复用互斥说明");
  assert.match(out, /effective model/, "回显说明（打错模型名的失败模式）");
  // R10-C（auditor 没问-1，并入 C-3 批）：回显措辞降级为 advisory——不得写成
  // 校验承诺（回显展示 WAO 下发了什么，不证明 provider 接受该 id）。
  assert.match(out, /shows what WAO threaded/, "回显措辞为 advisory（非校验承诺）");
  assert.doesNotMatch(out, /check the echoed/, "旧的祈使句措辞已移除");
});

test("R10-A-CLI-8: run --background --model 全链 — CLI JSON 回显 + runner→start 合成落 transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r10a-bg-"));
  try {
    // 不存在的 binary：detached runner 真实 fork（既有 TD-54/WF-6 模式），
    // 但 worker 在 spawn 即失败——零 provider、零 token。
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bg_mo: {
          backend: "claude-code",
          binary: "nonexistent-binary-r10a",
          cwd: dir,
          model: { id: "base-model" },
        },
      },
    }), "utf8");
    const runDir = join(dir, "runs");
    const result = spawnSync(process.execPath, [
      "src/cli.js", "run", "bg_mo",
      "--prompt", "x",
      "--background",
      "--model", "gpt-5.6-sol-xhigh",
      "--registry", registryPath,
      "--run-dir", runDir,
      "--wait-timeout", "2000",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });

    assert.equal(result.status, 0, `background dispatch 应立即返回 JSON: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.background, true);
    assert.deepEqual(parsed.model, { id: "gpt-5.6-sol-xhigh" },
      "后台 JSON 回显 effective model（dispatch 时刻可见）");

    // 等 runner 把 run 推到终态（binary 不存在 → spawn_error → failed）。
    const transcriptPath = join(runDir, `${parsed.runId}.jsonl`);
    let events = [];
    for (let i = 0; i < 50; i += 1) {
      if (existsSync(transcriptPath)) {
        events = await readTranscript(transcriptPath);
        if (["failed", "completed", "timed_out"].includes(findState(events))) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(events.length > 0, "runner 必须写 transcript");
    assert.equal(findState(events), "failed", "不存在 binary 应快速 failed");
    const started = events.find((e) => e.type === "run.started");
    assert.deepEqual(started.model, { id: "gpt-5.6-sol-xhigh" },
      "CLI→dispatchRun --model argv→backgroundRunner 解析→RunManager.start 合成，全链落地");
    assert.equal(started.modelOverride, "gpt-5.6-sol-xhigh", "run.started 携带显式 override 事实");
  } finally {
    rmrfRetry(dir);
  }
});

// ---------------------------------------------------------------------------
// R11-1（Owner 2026-08-17）：per-dispatch reasoning effort 覆盖（--reasoning
// <effort>）。与 --model 同机制的单次生效覆盖；闭集（minimal/low/medium/
// high/xhigh/max）；可与 --model 同用（"gpt-5.6-sol + xhigh" 场景）；两道硬
// 互斥（requireCertified / provider-session reuse）与 model 同语义；无能力
// 布尔——不可表达（opencode-serve）与条件子集（kimi K3 / dsh high|max）走
// 既有 per-backend policy 门自然拒绝。
// ---------------------------------------------------------------------------

// R11-1 前台共用夹具：registry 声明 model + reasoning，注入 backend 捕获合成
// 策略（与 makeModelOverrideFixture 同构，多一个静态 reasoning）。
function makeReasoningOverrideFixture(dir) {
  const spawnedPolicies = [];
  const fakeBackend = {
    validateAgentPolicy(agent) {
      assert.ok(agent.reasoning && typeof agent.reasoning.effort === "string",
        "synthesized reasoning reaches the ordinary policy validation surface");
    },
    async spawn(agent) {
      spawnedPolicies.push({ model: agent.model, reasoning: agent.reasoning });
      return {
        backend: "claude-code",
        backendSessionId: "s_r11a",
        messageId: "m_r11a",
        admittedSeq: 1,
        async *events() {
          yield { kind: "assistant", role: "assistant", parts: [{ type: "text", text: "done" }] };
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      return {
        id, backend: "claude-code", cwd: dir,
        model: { id: "glm-5.3", contextWindow: 1000000 },
        reasoning: { effort: "medium" },
        ...overrides,
      };
    },
    listAgents() { return []; },
  });
  const config = {
    registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
    timeout: 5000, retries: 0, backendFor: () => fakeBackend, readRegistry,
  };
  return { config, spawnedPolicies };
}

test("R11-1-CLI-1: run --model + --reasoning 前台 → 双覆盖合成 + run.started 双事实 + 合并回显行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r111-fg-"));
  try {
    const { config, spawnedPolicies } = makeReasoningOverrideFixture(dir);
    const out = await captureLog(async () => {
      await runCommand([
        "claude_worker", "--prompt", "hi", "--run-dir", dir,
        "--model", "gpt-5.6-sol-xhigh", "--reasoning", "xhigh",
      ], config);
    });
    // start 收到（并传给 spawn 的）双合成策略：id 与 effort 都被替换。
    assert.deepEqual(spawnedPolicies, [{
      model: { id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 },
      reasoning: { effort: "xhigh" },
    }], "dual override: only .id/.effort replaced, siblings preserved");
    // 合并回显行（advisory）：一次 effective 行同时携带 model 与 reasoning。
    assert.match(out,
      /effective model: \{"id":"gpt-5\.6-sol-xhigh","contextWindow":1000000\}, reasoning: \{"effort":"xhigh"\}/,
      "text format echoes BOTH effective policies on one merged line");
    // transcript 事实：run.started 的四个字段（双静态 + 双显式覆盖）。
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(files.length, 1, "one run transcript");
    const events = await readTranscript(join(dir, files[0]));
    const started = events.find((e) => e.type === "run.started");
    assert.deepEqual(started.model, { id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 });
    assert.deepEqual(started.reasoning, { effort: "xhigh" },
      "run.started.reasoning reflects the synthesized policy");
    assert.equal(started.modelOverride, "gpt-5.6-sol-xhigh");
    assert.equal(started.reasoningOverride, "xhigh",
      "run.started carries the explicit reasoning override fact");
  } finally {
    rmrfRetry(dir);
  }
});

test("R11-1-CLI-2: run --reasoning --format json → 结构化 reasoning 字段（无散行，输出保持可解析）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r111-fg-json-"));
  try {
    const { config } = makeReasoningOverrideFixture(dir);
    const out = await captureLog(async () => {
      await runCommand([
        "claude_worker", "--prompt", "hi", "--run-dir", dir, "--format", "json", "--reasoning", "high",
      ], config);
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.completed, true, "mock run 应 completed");
    assert.deepEqual(parsed.reasoning, { effort: "high" },
      "json format carries the structured effective reasoning");
    assert.doesNotMatch(out, /^effective /m, "json 分支不打印散行（保持机器可解析）");
  } finally {
    rmrfRetry(dir);
  }
});

test("R11-1-CLI-3: 无 --reasoning 的前台 run 字节不变（无回显行、run.started 无 reasoningOverride；静态 reasoning 照落）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r111-fg-none-"));
  try {
    const { config } = makeReasoningOverrideFixture(dir);
    const out = await captureLog(async () => {
      await runCommand(["claude_worker", "--prompt", "hi", "--run-dir", dir], config);
    });
    assert.doesNotMatch(out, /effective /, "无覆盖时无回显行");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const events = await readTranscript(join(dir, files[0]));
    const started = events.find((e) => e.type === "run.started");
    assert.equal("reasoningOverride" in started, false, "run.started 不携带覆盖事实（保持原形状）");
    assert.deepEqual(started.reasoning, { effort: "medium" },
      "静态 registry reasoning 现在照实落盘（审计缺口修复），无覆盖不合成");
  } finally {
    rmrfRetry(dir);
  }
});

test("R11-1-CLI-4: --reasoning 闭集门（集外值/大小写/裸旗标/-- 前缀）→ 固定文案 fail-fast", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r111-gate-"));
  try {
    const { config } = makeReasoningOverrideFixture(dir);
    const badArgvs = [
      ["--reasoning", "ultra"],           // 集外
      ["--reasoning", "HIGH"],            // 大小写敏感（不归一化）
      ["--reasoning"],                    // 裸 flag → parseOptions 给 true
      ["--reasoning", "--next-flag"],     // 值位被下一个 flag 占据
      ["--reasoning", ""],                // 空串
    ];
    for (const extra of badArgvs) {
      await assert.rejects(
        () => runCommand(["claude_worker", "--prompt", "hi", "--run-dir", dir, ...extra], config),
        (e) => {
          assert.match(e.message, /--reasoning must be one of the supported reasoning effort values/,
            `固定文案（${extra.join(" ")}）`);
          assert.match(e.message, /minimal\/low\/medium\/high\/xhigh\/max/, "文案列出闭集");
          assert.doesNotMatch(e.message, /ultra|HIGH|next-flag/, "不回显原值");
          return true;
        },
      );
    }
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".jsonl")), [], "零 transcript（全部在副作用前拒绝）");
  } finally {
    rmrfRetry(dir);
  }
});

test("R11-1-CLI-5: --reasoning × --require-certified → 互斥 fail-fast（闭集码文案指对旗标）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r111-cert-"));
  try {
    const { config } = makeReasoningOverrideFixture(dir);
    await assert.rejects(
      () => runCommand([
        "claude_worker", "--prompt", "hi", "--run-dir", dir,
        "--reasoning", "high", "--require-certified",
      ], config),
      (e) => {
        assert.match(e.message, /reasoning_override_certified_conflict/, "闭集理由码");
        assert.match(e.message, /--reasoning is mutually exclusive with --require-certified/, "文案指对 --reasoning 旗标");
        assert.match(e.message, /drop one of the two flags/i, "修复指引");
        return true;
      },
    );
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".jsonl")), [], "零 transcript");
  } finally {
    rmrfRetry(dir);
  }
});

test("R11-1-CLI-6: spawn --reasoning → 明确拒绝（--reasoning 是 run 专属表面）", async () => {
  await assert.rejects(
    () => spawnCommand(["researcher", "--prompt", "hi", "--reasoning", "high"], {}),
    (e) => {
      assert.match(e.message, /--reasoning is only supported on `run`, not `spawn`/);
      assert.match(e.message, /registry reasoning policy/, "指引持久化 effort 应改注册表");
      return true;
    },
  );
});

test("R11-1-CLI-7: run --help 用法页含 --reasoning（闭集 + 互斥 + 仅 run 面）", async () => {
  const out = await captureLog(() => runCommand(["--help"], {}));
  assert.match(out, /--reasoning EFFORT/, "flag 行存在");
  assert.match(out, /minimal\/low\/medium\/high\/xhigh\/max/, "闭集说明");
  assert.match(out, /mutually exclusive with\s+--require-certified/, "认证互斥说明");
  assert.match(out, /provider-session reuse agents/, "复用互斥说明");
  assert.match(out, /only on run and retry \(not\s+spawn\/workflow\/daemon\)/, "仅 run 与 retry 面（TD-126：retry 自 R12 起接受两 flag）");
  // 旧句反回归：R12 前的过时措辞（漏掉 retry）不得回潮。
  assert.doesNotMatch(out, /only on run \(not\s+spawn\/workflow\/daemon\)/, "TD-126 旧句不得回潮");
  assert.match(out, /effective reasoning/, "回显说明（advisory）");
});

test("R11-1-CLI-8: run --background --reasoning 全链 — CLI JSON 回显 + runner→start 合成落 transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r111-bg-"));
  try {
    // 不存在的 binary：detached runner 真实 fork（既有 TD-54/WF-6 模式），
    // 但 worker 在 spawn 即失败——零 provider、零 token。
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bg_ro: {
          backend: "claude-code",
          binary: "nonexistent-binary-r111",
          cwd: dir,
          reasoning: { effort: "medium" },
        },
      },
    }), "utf8");
    const runDir = join(dir, "runs");
    const result = spawnSync(process.execPath, [
      "src/cli.js", "run", "bg_ro",
      "--prompt", "x",
      "--background",
      "--reasoning", "xhigh",
      "--registry", registryPath,
      "--run-dir", runDir,
      "--wait-timeout", "2000",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });

    assert.equal(result.status, 0, `background dispatch 应立即返回 JSON: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.background, true);
    assert.deepEqual(parsed.reasoning, { effort: "xhigh" },
      "后台 JSON 回显 effective reasoning（dispatch 时刻可见）");

    // 等 runner 把 run 推到终态（binary 不存在 → spawn_error → failed）。
    const transcriptPath = join(runDir, `${parsed.runId}.jsonl`);
    let events = [];
    for (let i = 0; i < 50; i += 1) {
      if (existsSync(transcriptPath)) {
        events = await readTranscript(transcriptPath);
        if (["failed", "completed", "timed_out"].includes(findState(events))) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(events.length > 0, "runner 必须写 transcript");
    assert.equal(findState(events), "failed", "不存在 binary 应快速 failed");
    const started = events.find((e) => e.type === "run.started");
    assert.deepEqual(started.reasoning, { effort: "xhigh" },
      "CLI→dispatchRun --reasoning argv→backgroundRunner 解析→RunManager.start 合成，全链落地");
    assert.equal(started.reasoningOverride, "xhigh", "run.started 携带显式 override 事实");
  } finally {
    rmrfRetry(dir);
  }
});

// ---------------------------------------------------------------------------
// R12（Owner 2026-08-18）：retry 继承 per-dispatch 覆盖（"同形重试"，与 resume
// 重建链对称）。三道护栏：可见性回显（inheritedOverrides）、显式替换 flag
// （--model/--reasoning，与 run 同源 CLI 形状校验）、同一套校验门 + 坏持久化值
// fail-closed（固定文案指向源 run，零新 transcript）。源 run 无覆盖且未给 flag
// → 零覆盖，输出与旧 face 逐字节兼容。
// 夹具：注入 backend（捕获 spawn 收到的合成 policy）+ 原生形状 readRegistry；
// 源 transcript 手工落盘（readTranscript 只做逐行 JSON.parse，形状与真实
// run.started/prompt.sent 事实同构）。零 provider、零 token、零真实派发。
// ---------------------------------------------------------------------------

// R12 共用夹具：fake backend 捕获 spawn 的合成 policy；registry agent 带齐
// model+reasoning 静态策略（含兄弟字段，验证"只替换 .id/.effort"）。
function makeRetryInheritFixture(dir) {
  const spawned = [];
  const fakeBackend = {
    validateAgentPolicy(agent) {
      assert.ok(agent.model && typeof agent.model.id === "string",
        "synthesized model reaches the ordinary policy validation surface");
    },
    async spawn(agent) {
      spawned.push({ model: agent.model, reasoning: agent.reasoning });
      return {
        backend: "claude-code",
        backendSessionId: "s_r12",
        messageId: "m_r12",
        admittedSeq: 1,
        async *events() {
          yield { kind: "assistant", role: "assistant", parts: [{ type: "text", text: "done" }] };
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      return {
        id, backend: "claude-code", cwd: dir,
        model: { id: "glm-5.3", contextWindow: 1000000 },
        reasoning: { effort: "medium" },
        ...overrides,
      };
    },
    listAgents() { return []; },
  });
  const config = {
    registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
    timeout: 5000, retries: 0, backendFor: () => fakeBackend, readRegistry,
  };
  return { config, spawned };
}

/**
 * 解析 retry 输出的单个 pretty-printed JSON 对象。
 * 本文件 import 了 src/cli.js——其自执行 main() 的异步 printHelp() 可能落进
 * 首个执行测试的捕获窗口（既有套件级怪癖，对不做整体 JSON.parse 的测试无害）。
 * retryCommand 恰打印一个 JSON 对象且 HELP_TEXT 不含花括号，故从首个 "{" 切到
 * 末个 "}" 即可确定性还原（容忍前后污染）。
 */
function parseRetryJson(out) {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  assert.ok(start !== -1 && end > start, `retry JSON 输出应在捕获中（got: ${out.slice(0, 80)}…）`);
  return JSON.parse(out.slice(start, end + 1));
}

/** 落盘一个源 run transcript（run.started [+ 覆盖事实] + prompt.sent）。
 * R12-C C-1：事件信封带 runId——与真实 JsonlTranscript.append 同构（它给每条
 * 事件盖 runId 戳；readTranscript 只逐行 JSON.parse，不补信封）。omitStarted
 * 落盘"缺 run.started"的旧格式（R10 前）；extraEvents 追加在尾部（篡改探针：
 * 伪造 run.started 追加进同一 transcript 文件）。 */
function writeRetrySource(dir, runId, { modelOverride, reasoningOverride, omitStarted = false, extraEvents = [] } = {}) {
  const started = {
    seq: 1, ts: "2026-08-18T00:00:00.000Z", type: "run.started", runId, agentId: "claude_worker",
    backend: "claude-code", cwd: dir,
    model: { id: "glm-5.3", contextWindow: 1000000 },
    reasoning: { effort: "medium" },
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    ...(reasoningOverride !== undefined ? { reasoningOverride } : {}),
  };
  const prompt = {
    seq: 2, ts: "2026-08-18T00:00:00.100Z", type: "prompt.sent", runId, agentId: "claude_worker",
    prompt: "original task prompt",
  };
  const events = [...(omitStarted ? [] : [started]), prompt, ...extraEvents];
  writeFileSync(join(dir, `${runId}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

test("R12-CLI-1: 双覆盖继承全链 — start 收到同值合成（兄弟字段保留）+ 新 run.started 落双事实 + 回显 inherited", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r12-inherit-"));
  try {
    writeRetrySource(dir, "run_src", { modelOverride: "gpt-5.6-sol-xhigh", reasoningOverride: "xhigh" });
    const { config, spawned } = makeRetryInheritFixture(dir);
    const out = await captureLog(async () => {
      await retryCommand(["run_src", "--run-dir", dir], config);
    });
    const parsed = parseRetryJson(out);
    // start 收到同值（传给 spawn 的合成 policy：只替换 .id/.effort，兄弟字段保留）。
    assert.deepEqual(spawned, [{
      model: { id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 },
      reasoning: { effort: "xhigh" },
    }], "inherited overrides reach start's synthesis: only .id/.effort replaced");
    // 新 run.started 落同样的覆盖事实（start 只在收到 option 时才写该字段）。
    const events = await readTranscript(parsed.transcript);
    const started = events.find((e) => e.type === "run.started");
    assert.equal(started.modelOverride, "gpt-5.6-sol-xhigh", "新 run.started.modelOverride = 继承值");
    assert.equal(started.reasoningOverride, "xhigh", "新 run.started.reasoningOverride = 继承值");
    assert.deepEqual(started.model, { id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 });
    assert.deepEqual(started.reasoning, { effort: "xhigh" });
    // 可见性回显：advisory，值 + closed-set source 标记。
    assert.deepEqual(parsed.inheritedOverrides, {
      model: { value: "gpt-5.6-sol-xhigh", source: "inherited" },
      reasoning: { value: "xhigh", source: "inherited" },
    }, "继承时输出 inheritedOverrides（source: inherited）");
    assert.equal(parsed.originalRunId, "run_src");
  } finally {
    rmrfRetry(dir);
  }
});

test("R12-CLI-2: 显式替换 — --model/--reasoning 各自替换继承值，未替换者继续继承；纯替换标记 replaced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r12-replace-"));
  try {
    // 源：model 覆盖 + reasoning 覆盖各一；另备一个无覆盖源。
    writeRetrySource(dir, "run_m", { modelOverride: "gpt-5.6-sol-xhigh", reasoningOverride: "medium" });
    writeRetrySource(dir, "run_none");
    const { config, spawned } = makeRetryInheritFixture(dir);

    // (a) --model 替换：model 换新值、reasoning 保持继承。
    let out = await captureLog(() => retryCommand(["run_m", "--run-dir", dir, "--model", "glm-4.7"], config));
    let parsed = parseRetryJson(out);
    let events = await readTranscript(parsed.transcript);
    let started = events.find((e) => e.type === "run.started");
    assert.equal(started.modelOverride, "glm-4.7", "--model 替换继承的 model");
    assert.equal(started.reasoningOverride, "medium", "未给 --reasoning → 继续继承");
    assert.deepEqual(parsed.inheritedOverrides, {
      model: { value: "glm-4.7", source: "replaced" },
      reasoning: { value: "medium", source: "inherited" },
    }, "替换者 source: replaced，未替换者 source: inherited");

    // (b) --reasoning 替换：reasoning 换新值、model 保持继承。
    out = await captureLog(() => retryCommand(["run_m", "--run-dir", dir, "--reasoning", "max"], config));
    parsed = parseRetryJson(out);
    events = await readTranscript(parsed.transcript);
    started = events.find((e) => e.type === "run.started");
    assert.equal(started.modelOverride, "gpt-5.6-sol-xhigh", "未给 --model → 继续继承");
    assert.equal(started.reasoningOverride, "max", "--reasoning 替换继承的 effort");
    assert.deepEqual(parsed.inheritedOverrides, {
      model: { value: "gpt-5.6-sol-xhigh", source: "inherited" },
      reasoning: { value: "max", source: "replaced" },
    });

    // (c) 双替换：两个都标 replaced，替换值回显。
    out = await captureLog(() => retryCommand(["run_m", "--run-dir", dir, "--model", "glm-4.7", "--reasoning", "low"], config));
    parsed = parseRetryJson(out);
    events = await readTranscript(parsed.transcript);
    started = events.find((e) => e.type === "run.started");
    assert.equal(started.modelOverride, "glm-4.7");
    assert.equal(started.reasoningOverride, "low");
    assert.deepEqual(parsed.inheritedOverrides, {
      model: { value: "glm-4.7", source: "replaced" },
      reasoning: { value: "low", source: "replaced" },
    }, "双替换各自标记 replaced");

    // (d) 纯替换：源无覆盖 + 显式 flag → 回显 replaced（不是 inherited）。
    out = await captureLog(() => retryCommand(["run_none", "--run-dir", dir, "--model", "glm-4.7"], config));
    parsed = parseRetryJson(out);
    events = await readTranscript(parsed.transcript);
    started = events.find((e) => e.type === "run.started");
    assert.equal(started.modelOverride, "glm-4.7", "纯替换也在新 run.started 落覆盖事实");
    assert.deepEqual(parsed.inheritedOverrides, {
      model: { value: "glm-4.7", source: "replaced" },
    }, "源无覆盖 + 显式 flag → source: replaced");
    // 四次 retry 都真实 spawn 了合成 policy（最终态对账）。
    assert.equal(spawned.length, 4, "四次 retry 各 spawn 一次");
    assert.equal(spawned[3].model.id, "glm-4.7");
  } finally {
    rmrfRetry(dir);
  }
});

test("R12-CLI-3: 无覆盖 retry 输出逐字节兼容 — 无 inheritedOverrides 字段、新 run.started 无覆盖事实、spawn 用注册表原策略", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r12-none-"));
  try {
    writeRetrySource(dir, "run_plain");
    const { config, spawned } = makeRetryInheritFixture(dir);
    const out = await captureLog(() => retryCommand(["run_plain", "--run-dir", dir], config));
    const parsed = parseRetryJson(out);
    // 旧 face 的键集 = originalRunId/newRunId/transcript + run.result（backend 句柄
    // 四字段）。inheritedOverrides 缺席是字节回归的强钉（键集级而非子串级）。
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["admittedSeq", "backend", "backendSessionId", "messageId", "newRunId", "originalRunId", "transcript"],
      "无覆盖 retry 输出键集与旧 face 完全一致（无 inheritedOverrides）",
    );
    assert.ok(!out.includes("inheritedOverrides"), "输出字符串不含 inheritedOverrides");
    const events = await readTranscript(parsed.transcript);
    const started = events.find((e) => e.type === "run.started");
    assert.equal("modelOverride" in started, false, "新 run.started 无 modelOverride（payload 形状不变）");
    assert.equal("reasoningOverride" in started, false, "新 run.started 无 reasoningOverride");
    assert.deepEqual(started.model, { id: "glm-5.3", contextWindow: 1000000 }, "注册表原策略原样落盘");
    assert.deepEqual(spawned[0].model, { id: "glm-5.3", contextWindow: 1000000 }, "零合成：spawn 用注册表策略");
    assert.deepEqual(spawned[0].reasoning, { effort: "medium" });
  } finally {
    rmrfRetry(dir);
  }
});

test("R12-CLI-4: 坏持久化值 fail-closed — 五种坏 model 形 + 坏 reasoning 形全拒绝（固定文案指向源 run，零新 transcript）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r12-bad-"));
  try {
    // R10-A-CLI-4 的五种坏形（对持久化事实的镜像）：布尔（裸 flag 形）、空串、
    // "--" 前缀、含空白、超长。
    const badModels = [
      ["run_bad_bool", true],
      ["run_bad_empty", ""],
      ["run_bad_dash", "--next-flag"],
      ["run_bad_space", "has space"],
      ["run_bad_long", "x".repeat(129)],
    ];
    for (const [runId, value] of badModels) {
      writeRetrySource(dir, runId, { modelOverride: value });
    }
    // reasoning 坏形：集外 / 大小写 / 布尔 / 空串 / "--" 前缀。
    const badReasonings = [
      ["run_bad_r_ultra", "ultra"],
      ["run_bad_r_case", "HIGH"],
      ["run_bad_r_bool", true],
      ["run_bad_r_empty", ""],
      ["run_bad_r_dash", "--next"],
    ];
    for (const [runId, value] of badReasonings) {
      writeRetrySource(dir, runId, { reasoningOverride: value });
    }
    const seededCount = badModels.length + badReasonings.length;
    const { config } = makeRetryInheritFixture(dir);

    for (const [runId] of badModels) {
      await assert.rejects(
        () => retryCommand([runId, "--run-dir", dir], config),
        (e) => {
          assert.match(e.message, new RegExp(`Run ${runId}: retry refuses to inherit`),
            `固定文案指向源 run（${runId}）`);
          assert.match(e.message, /retry_inherit_model_invalid/, "闭集理由码");
          assert.match(e.message, /never\s+silently falls back/, "不静默降级声明");
          assert.match(e.message, /`run --model <id>`/, "修复指引：显式 run 重发");
          return true;
        },
      );
    }
    for (const [runId] of badReasonings) {
      await assert.rejects(
        () => retryCommand([runId, "--run-dir", dir], config),
        (e) => {
          assert.match(e.message, new RegExp(`Run ${runId}: retry refuses to inherit`));
          assert.match(e.message, /retry_inherit_reasoning_invalid/, "闭集理由码");
          assert.match(e.message, /`run --reasoning <effort>`/, "修复指引：显式 run 重发");
          return true;
        },
      );
    }
    // 全部在 manager.start 之前拒绝：runDir 里只有落盘的源 transcript，零新 transcript。
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(files.length, seededCount, "零新 transcript（fail-closed 先于 start）");
    // 显式替换 flag 不豁免坏值拒绝：坏 transcript 事实一律拒绝（要换策略请直接 run）。
    await assert.rejects(
      () => retryCommand(["run_bad_space", "--run-dir", dir, "--model", "glm-4.7"], config),
      /retry_inherit_model_invalid/,
      "corrupt persisted value + valid --model flag → 仍 fail-closed（integrity 优先于替换）",
    );
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length, seededCount,
      "替换 flag 不豁免坏值：仍零新 transcript");
  } finally {
    rmrfRetry(dir);
  }
});

test("R12-CLI-5: CLI 形状门复用 — retry 面的 --model/--reasoning 坏值以 run 同源固定文案拒绝，零新 transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r12-gate-"));
  try {
    writeRetrySource(dir, "run_src", { modelOverride: "gpt-5.6-sol-xhigh", reasoningOverride: "xhigh" });
    const { config } = makeRetryInheritFixture(dir);
    const badArgvs = [
      ["--model"],                        // 裸 flag → parseOptions 给 true
      ["--model", "--run-dir2"],          // 值位被下一个 flag 占据 → true
      ["--model", "has space"],           // 空白
      ["--model", "x".repeat(129)],       // 超长
      ["--reasoning", "ultra"],           // 集外
      ["--reasoning", "HIGH"],            // 大小写敏感（不归一化）
      ["--reasoning"],                    // 裸 flag → true
      ["--reasoning", ""],                // 空串
    ];
    for (const extra of badArgvs) {
      await assert.rejects(
        () => retryCommand(["run_src", "--run-dir", dir, ...extra], config),
        (e) => {
          if (extra[0] === "--model") {
            assert.match(e.message, /--model must be a non-empty string of at most 128 characters/,
              `--model 同源固定文案（${extra.join(" ")}）`);
            assert.doesNotMatch(e.message, /run_src.*refuses to inherit/, "形状门先于继承检查（不误报坏持久化值）");
          } else {
            assert.match(e.message, /--reasoning must be one of the supported reasoning effort values/,
              `--reasoning 同源固定文案（${extra.join(" ")}）`);
          }
          return true;
        },
      );
    }
    // 全部在副作用前拒绝：只有源 transcript，零新 transcript、零 spawn。
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    assert.deepEqual(files, ["run_src.jsonl"], "零新 transcript（gate 先于 loadRun/start）");
  } finally {
    rmrfRetry(dir);
  }
});

// ---------------------------------------------------------------------------
// R12-C（2026-08-18，R12 验收会审窄返工）：
// C-1 篡改探针：run.started 取法 = 首条 + runId 绑定。修复前 findLatest 取
//   尾条——append-only transcript 上尾部追加的伪造 run.started（形状合法的
//   modelOverride/reasoningOverride）会被采信并洗白进新 run 的一等事实。
// C-5 旧格式宽容：源 transcript 缺 run.started（R10 前）→ 零覆盖放行（?. 链），
//   与 resume 的拒绝语义不同但各自正确。
// ---------------------------------------------------------------------------

test("R12-CLI-6: 篡改探针 — 尾部伪造 run.started（同 runId + 形状合法覆盖）不被采信，retry 用真实首条（零覆盖）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r12-tamper-"));
  try {
    // 真实首条 run.started：无覆盖。尾部追加伪造：同 runId、双覆盖、形状全部合法
    // （修复前 findLatest 恰好采信这条——探针钉住"首条 + 绑定"两个维度一起修）。
    const forged = {
      seq: 3, ts: "2026-08-18T00:00:00.200Z", type: "run.started", runId: "run_real",
      agentId: "claude_worker", backend: "claude-code", cwd: dir,
      model: { id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 },
      reasoning: { effort: "xhigh" },
      modelOverride: "gpt-5.6-sol-xhigh", reasoningOverride: "xhigh",
    };
    writeRetrySource(dir, "run_real", { extraEvents: [forged] });
    const { config, spawned } = makeRetryInheritFixture(dir);
    const out = await captureLog(() => retryCommand(["run_real", "--run-dir", dir], config));
    const parsed = parseRetryJson(out);
    // 采信真实首条（零覆盖）：无回显、新 run.started 无覆盖事实、spawn 用注册表策略。
    assert.ok(!out.includes("inheritedOverrides"), "伪造尾部覆盖不得进回显");
    const events = await readTranscript(parsed.transcript);
    const started = events.find((e) => e.type === "run.started");
    assert.equal("modelOverride" in started, false, "伪造 modelOverride 不得洗白进新 run.started 一等事实");
    assert.equal("reasoningOverride" in started, false, "伪造 reasoningOverride 不得洗白进新 run.started");
    assert.deepEqual(spawned[0].model, { id: "glm-5.3", contextWindow: 1000000 }, "spawn 用注册表原策略（零覆盖）");
    assert.deepEqual(spawned[0].reasoning, { effort: "medium" });
  } finally {
    rmrfRetry(dir);
  }
});

test("R12-CLI-7: runId 绑定纪律 — 跨 run 的 run.started（不同 runId、带覆盖）对 retry 不可见", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r12-bind-"));
  try {
    // 载体 run_bound 的 transcript 里只有一条 FOREIGN runId 的 run.started（带形状
    // 合法覆盖）——绑定纪律下它不是本 run 的事实，retry 按零覆盖处理（宽容路径）。
    const foreign = {
      seq: 3, ts: "2026-08-18T00:00:00.000Z", type: "run.started", runId: "run_other",
      agentId: "claude_worker", backend: "claude-code", cwd: dir,
      model: { id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 },
      reasoning: { effort: "xhigh" },
      modelOverride: "gpt-5.6-sol-xhigh", reasoningOverride: "xhigh",
    };
    writeRetrySource(dir, "run_bound", { omitStarted: true, extraEvents: [foreign] });
    const { config, spawned } = makeRetryInheritFixture(dir);
    const out = await captureLog(() => retryCommand(["run_bound", "--run-dir", dir], config));
    const parsed = parseRetryJson(out);
    assert.ok(!out.includes("inheritedOverrides"), "跨 run 覆盖不得进回显");
    const events = await readTranscript(parsed.transcript);
    const started = events.find((e) => e.type === "run.started");
    assert.equal("modelOverride" in started, false, "跨 run 的覆盖事实不得落进新 run.started");
    assert.equal("reasoningOverride" in started, false);
    assert.deepEqual(spawned[0].model, { id: "glm-5.3", contextWindow: 1000000 }, "spawn 用注册表原策略（零覆盖）");
  } finally {
    rmrfRetry(dir);
  }
});

test("R12-CLI-8: 旧格式宽容 — 源 transcript 缺 run.started（R10 前）→ retry 按零覆盖放行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r12-legacy-"));
  try {
    writeRetrySource(dir, "run_old", { omitStarted: true });
    const { config, spawned } = makeRetryInheritFixture(dir);
    const out = await captureLog(() => retryCommand(["run_old", "--run-dir", dir], config));
    const parsed = parseRetryJson(out);
    // 零覆盖放行（?. 链）：不拒绝、无 inheritedOverrides、输出键集与旧 face 一致。
    assert.ok(!out.includes("inheritedOverrides"));
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["admittedSeq", "backend", "backendSessionId", "messageId", "newRunId", "originalRunId", "transcript"],
      "旧格式零覆盖 retry 输出键集与旧 face 完全一致",
    );
    const events = await readTranscript(parsed.transcript);
    const started = events.find((e) => e.type === "run.started");
    assert.equal("modelOverride" in started, false);
    assert.equal("reasoningOverride" in started, false);
    assert.deepEqual(spawned[0].model, { id: "glm-5.3", contextWindow: 1000000 }, "注册表原策略原样落盘");
    assert.deepEqual(spawned[0].reasoning, { effort: "medium" });
  } finally {
    rmrfRetry(dir);
  }
});

// ---------------------------------------------------------------------------
// R13（2026-08-18，TD-127）：retry 任务文本取法绑定修复。
// 修复前 lifecycle.js 用无绑定 findLatest(events, "prompt.sent")——尾部追加的
// 伪造 prompt.sent（同 runId 或跨 runId）会被原样重新派发（auditor 探针实证）。
// 修复：共享绑定读取器（transcript.js findLatestBound/findFirstBound，单一定义）
// + retry 面的 messageId 优先收窄（合法 TD-54 双写形状里第二条才带 messageId）。
// 诚实边界：绑定挡跨 run 注入/错读；同 runId 且形状完整的伪造仍会被采信——
// 该攻击者已持有 runs/ 写权限（与 R12-C run.started 侧信道同级）。
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

test("R13-CLI-3: 篡改探针（同 runId）— 无 messageId 尾部伪造被收窄挡下；形状完整伪造仍采信（诚实边界钉当前行为）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r13-srun-"));
  try {
    // (a) 合法双写 + 尾部无 messageId 的同 runId 伪造：messageId 优先收窄 →
    //     取合法第二写（带 messageId），伪造文本不派发。
    writeRetrySource(dir, "run_naive", {
      extraEvents: [
        { seq: 3, ts: "2026-08-18T00:00:00.150Z", type: "prompt.sent", runId: "run_naive",
          agentId: "claude_worker", messageId: "m_legal", admittedSeq: 5, prompt: "legal second write" },
        { seq: 4, ts: "2026-08-18T00:00:00.200Z", type: "prompt.sent", runId: "run_naive",
          agentId: "claude_worker", prompt: "FORGED naive same-run tail" },
      ],
    });
    const { config } = makeRetryInheritFixture(dir);
    let out = await captureLog(() => retryCommand(["run_naive", "--run-dir", dir], config));
    let dispatched = await readRedispatchedPrompt(parseRetryJson(out).transcript);
    assert.equal(dispatched, "legal second write", "同 runId 无 messageId 伪造被收窄挡下——取合法带 messageId 的最后一条");

    // (b) 诚实边界：同 runId 且带 messageId 的形状完整伪造仍被采信——绑定与
    //     收窄都无法区分"合法追加"与"持有 runs/ 写权限者的形状完整伪造"
    //     （与 R12-C 对 run.started 的边界结论同级）。此处钉住当前行为；
    //     更强的收窄需要写入端完整性（如哈希链），不在 R13 范围。
    writeRetrySource(dir, "run_shape", {
      extraEvents: [{
        seq: 3, ts: "2026-08-18T00:00:00.200Z", type: "prompt.sent", runId: "run_shape",
        agentId: "claude_worker", messageId: "m_forged", admittedSeq: 6,
        prompt: "FORGED shape-complete same-run tail",
      }],
    });
    out = await captureLog(() => retryCommand(["run_shape", "--run-dir", dir], config));
    dispatched = await readRedispatchedPrompt(parseRetryJson(out).transcript);
    assert.equal(dispatched, "FORGED shape-complete same-run tail",
      "诚实边界（钉当前行为）：同 runId + 形状完整的伪造仍被采信——防御上限是写权限边界，非读取端绑定");
  } finally {
    rmrfRetry(dir);
  }
});

test("R13-CLI-4: 合法双条回归 — TD-54 双 prompt.sent（第二条带 messageId）→ retry 取第二条（现行为不变）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r13-dbl-"));
  try {
    // runManager.start 的合法形状：spawn 前首写 {prompt}，spawn 后补写
    // {messageId, admittedSeq, prompt}（runManager.js:1191/1220）。两条文本用
    // 不同值以分辨取法——断言"取最后一条本 run 记录"语义在绑定后原样保留。
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
    // 修复后走既有 "no stored prompt" 拒绝面（与 pre-v0.0.2 无 prompt 记录同面）。
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
        assert.match(e.message, /Run run_none has no stored prompt/, "走既有无 prompt 拒绝文案");
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
