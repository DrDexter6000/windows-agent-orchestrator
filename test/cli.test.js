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
import { parseOptions, loadPrompt, runAndWait, buildDashboard, runsDashboardCommand, runCommand, statusCommand, collectCommand, resolveTargetCwd } from "../src/cli.js";
import { readTranscript, findState } from "../src/transcript.js";

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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientRmError(error) {
  return error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "ENOTEMPTY";
}

function rmrfRetry(dir, { retries = 20, delayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isTransientRmError(error) || attempt >= retries) throw error;
      sleepSync(delayMs);
    }
  }
}

test("rmrfRetry: retries transient Windows EPERM while a background process holds cwd", () => {
  if (process.platform !== "win32") return;

  const dir = mkdtempSync(join(tmpdir(), "wao-rmrf-retry-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 250)"], {
    cwd: dir,
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    sleepSync(50);
    assert.throws(
      () => rmSync(dir, { recursive: true, force: true }),
      (error) => error?.code === "EPERM" || error?.code === "EBUSY",
      "direct rmSync should fail while the child still holds cwd on Windows",
    );

    rmrfRetry(dir, { retries: 20, delayMs: 50 });
    assert.equal(existsSync(dir), false);
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
  const { ClaudeCodeBackend } = await import("../src/backends/claudeCode.js");
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
        coder_hq:   { backend: "claude-code", binary: "/x", cwd: dir, args: ["--model", "glm-5.2"] },
        researcher: { backend: "claude-code", binary: "/x", cwd: dir, args: ["--model", "deepseek-v4-flash"] },
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

    const out = execSync(`node src/cli.js registry list --registry ${registryPath} --run-dir ${runDir}`, {
      cwd: process.cwd(), encoding: "utf8",
    });
    const lines = out.trim().split(/\r?\n/);
    assert.equal(lines.length, 2, "应列出 2 个 agent");
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
      agents: { coder_hq: { backend: "claude-code", binary: "/x", cwd: dir, args: ["--model", "glm-5.2"] } },
    }), "utf8");

    const out = execSync(`node src/cli.js registry list --registry ${registryPath}`, {
      cwd: process.cwd(), encoding: "utf8",
    });
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

    const out = execSync(`node src/cli.js registry list --registry ${registryPath}`, {
      cwd: process.cwd(), encoding: "utf8",
    });
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
        coder_hq: { backend: "claude-code", binary: "/x", cwd: dir, args: ["--model", "glm-5.2"] },
        researcher: { backend: "claude-code", binary: "/x", cwd: dir, args: ["--model", "deepseek-v4-flash"] },
      },
    }), "utf8");

    const out = execSync(`node src/cli.js registry list --registry ${registryPath} --run-dir ${dir} --format json`, {
      cwd: process.cwd(), encoding: "utf8",
    });
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

    const out = execSync(`node src/cli.js registry validate --registry ${registryPath}`, {
      cwd: process.cwd(), encoding: "utf8",
    });
    // validate 通过（✔），但有 ⚠ warning 提示 tokenBudget 对 kimi 无效
    assert.match(out, /✔\s*coder_mm/, "kimi worker validate 通过");
    assert.match(out, /⚠.*kimi-code.*tokenBudget.*不生效/, "配了 tokenBudget 的 kimi worker 应有 ⚠ warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-89: registry validate 对非 claude-code + systemPrompt 给 ⚠ warning（静默失效）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-regval-sysprompt-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        // kimi-code + systemPrompt → 应 warn
        coder_mm: { backend: "kimi-code", cwd: dir, systemPrompt: "config/roles/coder_mm.md" },
        // codex + systemPrompt → 应 warn
        tester: { backend: "codex", cwd: dir, systemPrompt: "config/roles/tester.md" },
        // claude-code + systemPrompt → 不应 warn（该 backend 真正消费 systemPrompt）
        researcher: { backend: "claude-code", cwd: dir, systemPrompt: "config/roles/researcher.md" },
        // kimi-code 无 systemPrompt → 不应 warn（没配就不存在失效）
        coder_plain: { backend: "kimi-code", cwd: dir },
      },
    }), "utf8");

    const out = execSync(`node src/cli.js registry validate --registry ${registryPath}`, {
      cwd: process.cwd(), encoding: "utf8",
    });
    // 非 claude-code + systemPrompt → ⚠ warning
    assert.match(out, /⚠.*coder_mm.*kimi-code.*不消费 systemPrompt/, "kimi-code 配 systemPrompt 应 warn");
    assert.match(out, /⚠.*tester.*codex.*不消费 systemPrompt/, "codex 配 systemPrompt 应 warn");
    // claude-code + systemPrompt → 无该 warning（该 backend 消费 systemPrompt）
    const researcherBlock = out.split("\n").filter(l => l.includes("researcher")).join("\n");
    assert.doesNotMatch(researcherBlock, /⚠.*systemPrompt/, "claude-code + systemPrompt 不应 warn（真正消费）");
    // 无 systemPrompt → 无该 warning
    const plainBlock = out.split("\n").filter(l => l.includes("coder_plain")).join("\n");
    assert.doesNotMatch(plainBlock, /⚠.*systemPrompt/, "无 systemPrompt 的 worker 不应 warn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-90: getWaoCliPath 在 win32 返回 .cmd shim（worker 不踩 v24 guard）", async () => {
  // dogfood round 7 实证：worker 收到的 $WAO_CLI 原指向裸 src/cli.js，worker shell
  // 默认 node v24，直接 `node $WAO_CLI` 触发 nodeVersionGuard 被拒。TD-90 修复让
  // Windows 上 getWaoCliPath 返回 scripts/wao-cli.cmd（内部用 v22 node 绝对路径）。
  const { getWaoCliPath } = await import("../src/waoCliPath.js");
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
// _guardBypass.mjs 已全局设 WAO_SKIP_VERSION_GUARD=1，子进程继承，故任意 Node 可跑 help。
// 防止 printHelp 与代码漂移（首装 e2e 摩擦日志 F1：曾漏列 dashboard/diagnose/forecast/wao 族/daemon supervise）。
test("help: 列出所有 main() 真实路由的命令族（防 help 与代码漂移，TD-52）", () => {
  const out = execSync("node src/cli.js help", { cwd: process.cwd(), encoding: "utf8" });
  assert.match(out, /run <agentId> .*--prompt-file FILE/, "help 必须列出 run --prompt-file FILE");
  assert.match(out, /--scorecard-rules-file FILE/, "help 必须列出 --scorecard-rules-file FILE");
  assert.match(out, /status <runId> .*--format json/, "help 必须列出 status --format json");
  // runs 族（M8-2/3/4 新增，曾漏）
  assert.match(out, /runs dashboard/, "help 必须列出 runs dashboard（main() 路由）");
  assert.match(out, /runs diagnose/, "help 必须列出 runs diagnose（main() 路由）");
  assert.match(out, /runs forecast/, "help 必须列出 runs forecast（main() 路由）");
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

test("TD-88: workflow list 列出模板 + workflow run 按名字解析", () => {
  // workflow list 应列出 analyze-implement 和 parallel-research 两个模板
  const r = spawnSync(process.execPath, ["src/cli.js", "workflow", "list"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, `workflow list 应成功，stderr=${r.stderr}`);
  assert.match(r.stdout, /analyze-implement/, "list 应列出 analyze-implement 模板");
  assert.match(r.stdout, /parallel-research/, "list 应列出 parallel-research 模板");
  assert.match(r.stdout, /workflow run <名字>/, "list 提示按名字调用用法");

  // 按名字调用应解析到 templates/ 目录（不传 --vars 让它报"占位符未解析"或正常加载）
  // 这里只验证名字解析不报"文件不存在"——加载成功即说明解析对了
  const r2 = spawnSync(process.execPath, [
    "src/cli.js", "workflow", "run", "parallel-research",
    "--vars", "topicA=testA", "--vars", "topicB=testB",
    "--registry", "config/agents.example.json", // 用 example 避免依赖真实 agents.json
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 15000 });
  // 不验证 workflow 执行结果（需要真实 backend），只验证没报"找不到文件"
  assert.doesNotMatch(r2.stderr || "", /MODULE_NOT_FOUND|Cannot find module.*parallel-research/,
    "按名字调用应解析到模板文件，不报模块未找到");
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
          args: ["--model", "claude-opus-4-8"],
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

test("wao doctor: never-inited 目录的 wao_init 不应让 preflight FAIL（fresh-agent 第一步语义）", () => {
  // fresh-agent 把 doctor 当 preflight 第一道（onboarding §4d），"未 init" 是 init 之前的
  // 正常初态，不该和 401/key 缺/CLI 缺（真不健康）同列。降级为 WARN：exit 0、verdict 不含 ISSUE。
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-noinit-"));
  try {
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
    assert.ok(waoInit, "doctor 应有 wao_init 检查项");
    // 未初始化 = WARN，不计入 failed → exit 0（preflight 不因"还没 init"判失败）
    assert.equal(waoInit.pass, true, "未初始化的 wao_init 不应 FAIL（fresh-agent preflight 第一步语义）");
    assert.equal(waoInit.level, "warn");
    assert.equal(result.status, 0, "never-inited 目录 doctor 应 exit 0（未 init 是正常初态，非不健康）");
    assert.match(parsed.verdict, /WARN|HEALTHY/);
    assert.ok(!/ISSUE/.test(parsed.verdict), "未 init 不应让 verdict 出现 ISSUE");
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
  const dir = mkdtempSync(join(tmpdir(), "wao-doctor-strict-"));
  try {
    const result = spawnSync(process.execPath, [
      "src/cli.js", "wao", "doctor",
      "--cwd", dir,
      "--strict",
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 30000 });
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
      "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 10000 });
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
  const { ClaudeCodeBackend } = await import("../src/backends/claudeCode.js");
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
  const { ClaudeCodeBackend } = await import("../src/backends/claudeCode.js");
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
