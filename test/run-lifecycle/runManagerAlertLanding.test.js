// test/run-lifecycle/runManagerAlertLanding.test.js
//
// TD-239 残余收口回归钉：runManager 八处告警（budget / no_effect / stop_unverified×6）
// 的 ALERTS.log 落点必须跟随本 run 实际写转录的目录 dirname(transcript.filePath)，
// 绝不回落 config.runDir 或进程 cwd——与 runStop TD-233 同族同根因（runStop 用
// deps.alert 注入观察 logPath；runManager 无注入口，故用真实 raiseAlert 落盘 +
// 读文件观察，落盘先于弹窗、fire-and-forget 不阻塞终态，轮询等写完成）。
//
// 钉法对准声称（不是"代码能跑"）：
//   R1  override 形态 + budget 告警——config.runDir ≠ 转录目录，告警只落转录目录；
//   R2  override 形态 + stop_unverified（probe 成功但进程仍活，runManager :3326 形）；
//   R3  override 形态 + stop_unverified（probe 抛错，runManager :3292 形）；
//   R4  override 形态 + no_effect 告警（直接构造 Run 打 _raiseNoEffectAlert 精确点）；
//   R5  fail-safe：transcript 不可得 → _alertsLogPath() 回落原 config.runDir。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { RunManager, Run } from "../../src/runManager.js";
import { JsonlTranscript } from "../../src/transcript.js";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// 告警是 fire-and-forget（.catch(() => {}) 不被终态 await），落盘先于弹窗步骤，
// 轮询等 appendFile 完成；deadline 兜底返回最后一次探测结果。
async function waitForFile(path, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return existsSync(path);
}

// 两个目录刻意不同：configDir 会被预创建——"configDir 里没有 ALERTS.log"才是
// 有区分力的断言（不是目录不存在导致的假阴性）。
function makeDivergentDirs(root) {
  const configDir = join(root, "config-runs");
  const transcriptDir = join(root, "transcript-runs");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(transcriptDir, { recursive: true });
  return { configDir, transcriptDir };
}

function readAlerts(dir) {
  return readFileSync(join(dir, "ALERTS.log"), "utf8");
}

// ── R1: budget 告警落转录目录（override 形态）──────────────────────────────
//
// growing metrics（2000,4000,8000…×100）第 3 轮超 budget=500000 → 走
// runManager 的 budget 硬闸门 + raiseAlert("budget")。start options.runDir
// 分流转录目录，config.runDir 保持另一个目录——修前告警会写错目录。

test("TD-239-R1: budget 告警落转录目录——config.runDir ≠ 实际转录目录（override 形态）", async () => {
  const root = makeTempDir("wao-td239-r1-");
  try {
    const { configDir, transcriptDir } = makeDivergentDirs(root);
    let abortCalls = 0;
    const backend = {
      async spawn() {
        return {
          backend: "opencode-serve",
          backendSessionId: "ses_td239_r1",
          messageId: "msg_td239_r1",
          admittedSeq: null,
          events: async function* (signal, opts) {
            const interval = opts?.pollInterval ?? 5;
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "working" }] };
            let round = 0;
            while (!signal?.aborted) {
              round += 1;
              yield { kind: "metrics", tokens: { input: 2000 * Math.pow(2, round - 1), output: 10, reasoning: 0 } };
              await new Promise((r) => setTimeout(r, interval));
            }
          },
          abort: async () => { abortCalls += 1; },
        };
      },
      async streamEvents() { throw new Error("not used"); },
      async abort() { abortCalls += 1; },
    };
    const config = {
      registry: "x", runDir: configDir, pollInterval: 5, waitTimeout: 2000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id) {
        return { id, backend: "opencode-serve", serveUrl: "http://x", cwd: root, tokenBudget: 500000, tokenBudgetMultiplier: 100 };
      },
      listAgents() { return []; },
    });
    const manager = new RunManager({ config, readRegistry, backendFor: () => backend });

    const run = await manager.start("a", { prompt: "go", runDir: transcriptDir });
    // 形状自检：转录确实落在 override 目录（与 config.runDir 分离的形态成立）。
// D2-②b：manager 自决写桶——转录在 transcriptDir 下 projects/<slug>/ 内，
    // 目录关系断言从"恰好等于 runDir"放宽为"仍在 transcriptDir 树内且不在 configDir"
    assert.ok(resolve(dirname(run.transcript.filePath)).startsWith(resolve(transcriptDir)),
      "形状前提：转录必须实际落在 override 目录树内（D2-②b 分桶子目录）");

    const result = await run.waitForCompletion({ pollInterval: 5 });
    assert.equal(result.budgetExceeded, true, "预算闸门必须触发（否则告警不会发）");
    assert.equal(run.state, "failed");

    const alertPath = join(dirname(run.transcript.filePath), "ALERTS.log");
    assert.ok(await waitForFile(alertPath), "ALERTS.log 必须落在转录目录");
    assert.match(readAlerts(dirname(run.transcript.filePath)), /\[budget\]/, "落盘内容必须是 budget 告警");
    assert.equal(existsSync(join(configDir, "ALERTS.log")), false,
      "config.runDir 目录不得出现 ALERTS.log（修前 bug 形态）");
  } finally {
    cleanupDir(root);
  }
});

// ── R2/R3: stop_unverified 两形态（probe 成功仍活 / probe 抛错）────────────
//
// 进程式 handle 带 isAlive → _runCleanup 走 verifyProcessExit 探针：
//   R2 isAlive 恒 true → quiet=false → run.stop_unverified(alive) + 告警
//      "process may still be running"（runManager :3326 形）；
//   R3 isAlive 抛错 → probeThrew → run.stop_unverified{outcome:"probe_error"}
//      + 告警 "probe error"（runManager :3292 形）。

function makeProbeManager(root, { configDir, transcriptDir }, isAlive, runId) {
  const backend = {
    async spawn() {
      return {
        backend: "process",
        backendSessionId: `proc_${runId}`,
        events: async function* () {
          yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "x" }] };
          await new Promise((r) => setTimeout(r, 20));
          yield { kind: "done", reason: "failed", error: "natural failure" };
        },
        abort: async () => {},
        isAlive,
      };
    },
  };
  const config = {
    registry: "x", runDir: configDir, pollInterval: 10, waitTimeout: 5000,
    timeout: 5000, retries: 0, defaultIsolation: "none",
  };
  const readRegistry = async () => ({
    getAgent(id) { return { id, backend: "claude-code", cwd: root }; },
    listAgents() { return []; },
  });
  return new RunManager({ config, readRegistry, backendFor: () => backend });
}

test("TD-239-R2: stop_unverified（probe 成功仍活）告警落转录目录（override 形态）", async () => {
  const root = makeTempDir("wao-td239-r2-");
  try {
    const dirs = makeDivergentDirs(root);
    const manager = makeProbeManager(root, dirs, () => true, "td239_r2");
    const run = await manager.start("a", { prompt: "x", runDir: dirs.transcriptDir, runId: "td239_r2" });
    await assert.rejects(() => run.waitForCompletion({ waitTimeout: 5000, pollInterval: 10 }), /natural failure/);

    // D2-②b：告警随转录实际目录（分桶子目录），真合同=不在 configDir。
    const alertPath = join(dirname(run.transcript.filePath), "ALERTS.log");
    assert.ok(await waitForFile(alertPath, { timeoutMs: 8000 }), "ALERTS.log 必须落在转录目录");
    const content = readAlerts(dirname(run.transcript.filePath));
    assert.match(content, /\[stop_unverified\]/);
    assert.match(content, /may still be running/, "必须是 probe 成功仍活形态的文案");
    assert.equal(existsSync(join(dirs.configDir, "ALERTS.log")), false,
      "config.runDir 目录不得出现 ALERTS.log（修前 bug 形态）");
  } finally {
    cleanupDir(root);
  }
});

test("TD-239-R3: stop_unverified（probe 抛错）告警落转录目录（override 形态）", async () => {
  const root = makeTempDir("wao-td239-r3-");
  try {
    const dirs = makeDivergentDirs(root);
    const manager = makeProbeManager(root, dirs, () => { throw new Error("probe exploded"); }, "td239_r3");
    const run = await manager.start("a", { prompt: "x", runDir: dirs.transcriptDir, runId: "td239_r3" });
    await assert.rejects(() => run.waitForCompletion({ waitTimeout: 5000, pollInterval: 10 }), /natural failure/);

    const alertPath = join(dirname(run.transcript.filePath), "ALERTS.log");
    assert.ok(await waitForFile(alertPath), "ALERTS.log 必须落在转录目录");
    const content = readAlerts(dirname(run.transcript.filePath));
    assert.match(content, /\[stop_unverified\]/);
    assert.match(content, /probe error/, "必须是 probe 抛错形态的文案");
    assert.equal(existsSync(join(dirs.configDir, "ALERTS.log")), false,
      "config.runDir 目录不得出现 ALERTS.log（修前 bug 形态）");
  } finally {
    cleanupDir(root);
  }
});

// ── R4: no_effect 告警（直接构造 Run 精确打点）────────────────────────────
//
// 完整生命周期驱动 completed_empty × 交付失败出口机械量大（scorecard/打包链），
// 而该告警的落点决策全在 _raiseNoEffectAlert 内——m12-4b 先例的直接构造 Run
// 打点即可精确证伪"落点跟随转录目录"这一声称。门控三条件照实构造：
// deliveryContext 在场 + marker=completed_empty + 未防重。

test("TD-239-R4: no_effect 告警落转录目录——config.runDir ≠ 实际转录目录（override 形态）", async () => {
  const root = makeTempDir("wao-td239-r4-");
  try {
    const { configDir, transcriptDir } = makeDivergentDirs(root);
    const runId = "td239_r4_no_effect";
    const transcript = new JsonlTranscript(join(transcriptDir, `${runId}.jsonl`), {
      runId,
      agentId: "coder_td239",
    });
    const run = new Run({
      runId,
      agentId: "coder_td239",
      agent: { id: "coder_td239", cwd: root },
      backend: {},
      handle: {
        backend: "claude-code",
        backendSessionId: "ses_td239_r4",
        events() { throw new Error("not used"); },
        async abort() {},
      },
      transcript,
      result: { backend: "claude-code", backendSessionId: "ses_td239_r4" },
      config: { runDir: configDir },
      onRemove: () => {},
      initialState: "failed",
      deliveryContext: { runId },
      packageDeliveryFn: async () => { throw new Error("not used"); },
    });

    run._raiseNoEffectAlert("completed_empty", "td239-r4 no_effect landing pin");

    const alertPath = join(dirname(run.transcript.filePath), "ALERTS.log");
    assert.ok(await waitForFile(alertPath), "ALERTS.log 必须落在转录目录");
    const content = readAlerts(dirname(run.transcript.filePath));
    assert.match(content, /\[no_effect\]/);
    assert.match(content, /td239-r4 no_effect landing pin/);
    assert.equal(existsSync(join(configDir, "ALERTS.log")), false,
      "config.runDir 目录不得出现 ALERTS.log（修前 bug 形态）");
  } finally {
    cleanupDir(root);
  }
});

// ── R5: fail-safe——transcript 不可得时回落原 config.runDir ────────────────
//
// 理论上不可达（八处调用点都在有转录的 run 生命周期内）；契约要求该臂存在且
// 不引入新失败面：handle.redact 在场使构造器不触 transcript.redact 链。

test("TD-239-R5: _alertsLogPath fail-safe——transcript 不可得回落 config.runDir", () => {
  const root = makeTempDir("wao-td239-r5-");
  try {
    const configDir = join(root, "config-runs");
    const run = new Run({
      runId: "td239_r5",
      agentId: "coder_td239",
      agent: { id: "coder_td239", cwd: root },
      backend: {},
      handle: {
        backend: "claude-code",
        backendSessionId: "ses_td239_r5",
        redact: (v) => v,
        events() { throw new Error("not used"); },
        async abort() {},
      },
      transcript: undefined,
      result: { backend: "claude-code", backendSessionId: "ses_td239_r5" },
      config: { runDir: configDir },
      onRemove: () => {},
      initialState: "failed",
    });
    assert.equal(run._alertsLogPath(), join(configDir, "ALERTS.log"),
      "transcript 不可得时必须回落原 config.runDir 路径（不抛、不落 cwd）");
    assert.notEqual(run._alertsLogPath(), join(process.cwd(), "ALERTS.log"),
      "fail-safe 臂同样绝不落进程 cwd");
  } finally {
    cleanupDir(root);
  }
});
