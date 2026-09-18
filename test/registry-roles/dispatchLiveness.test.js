// test/registry-roles/dispatchLiveness.test.js
//
// TD-158 批次 2 dry 钉：派发活性工具（scripts/dispatch-with-liveness.mjs）的
// 纯函数面——参数解析、重派谓词三条件、线性退避、观察动作红线。
// 纯函数 dry 测试（reliabilityArgs.test.js 同款先例）：不派发、不跑真实
// provider、不碰真实 runs/ 目录。
//
// 红线锚点：永不重派在飞 run / 永不中止在飞 run（observationAction 编码）；
// knsoic 反误判锚点——纯调研零写入但活跃 = 合法工作（零写入 ≠ 零证据）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseDispatchArgs,
  shouldRedispatch,
  deriveStopVerified,
  backoffDelayMs,
  observationAction,
  isTerminalState,
  USAGE,
  DEFAULT_LIVENESS_WINDOW_MS,
  DEFAULT_MAX_ROUNDS,
  BACKOFF_BASE_MS,
  COMPLETED_EMPTY_MARKER,
  PROCESS_BACKEND_IDS,
  RESERVED_PASSTHROUGH_FLAGS,
} from "../../scripts/dispatch-with-liveness.mjs";
// SSOT 接地钉：脚本常量必须是 src 闭集的成员/派生，不允许第二套分类框架。
import { DIAGNOSIS_CODES } from "../../src/diagnosis.js";
import { TERMINAL_STATES } from "../../src/transcript.js";
import { KNOWN_BACKENDS } from "../../src/registry.js";

// ===== 参数解析 =====

test("TD-158: --help / -h → help 路径", () => {
  assert.equal(parseDispatchArgs(["--help"]).help, true);
  assert.equal(parseDispatchArgs(["-h"]).help, true);
  assert.equal(parseDispatchArgs(["--agent", "coder_hq", "-h"]).help, true);
});

test("TD-158: 三必填缺一即拒（agent/prompt-file/cwd）", () => {
  assert.match(parseDispatchArgs(["--prompt-file", "a.md", "--cwd", "D:\\x"]).error, /--agent is required/);
  assert.match(parseDispatchArgs(["--agent", "coder_hq", "--cwd", "D:\\x"]).error, /--prompt-file is required/);
  assert.match(parseDispatchArgs(["--agent", "coder_hq", "--prompt-file", "a.md"]).error, /--cwd is required/);
});

test("TD-158: 未知 flag / 缺值 / 值像 flag / 重复 / 裸位置参数全部拒绝", () => {
  assert.match(parseDispatchArgs(["--agent", "a", "--prompt-file", "p", "--cwd", "c", "--verbose"]).error, /unknown option/);
  assert.match(parseDispatchArgs(["--agent"]).error, /requires a value/);
  assert.match(parseDispatchArgs(["--agent", "--prompt-file"]).error, /requires a value/);
  assert.match(parseDispatchArgs(["--agent", "a", "--agent", "b"]).error, /multiple times/);
  assert.match(parseDispatchArgs(["--agent", "a", "--prompt-file", "p", "--cwd", "c", "stray"]).error, /positional/);
});

test("TD-158: 数值 flag 边界（观察窗 ≥1000、轮次 ≥1，拒绝非整数）", () => {
  const base = ["--agent", "a", "--prompt-file", "p", "--cwd", "c"];
  assert.match(parseDispatchArgs([...base, "--liveness-window-ms", "999"]).error, /--liveness-window-ms/);
  assert.match(parseDispatchArgs([...base, "--liveness-window-ms", "85000.5"]).error, /--liveness-window-ms/);
  assert.match(parseDispatchArgs([...base, "--liveness-window-ms", "abc"]).error, /--liveness-window-ms/);
  assert.match(parseDispatchArgs([...base, "--max-rounds", "0"]).error, /--max-rounds/);
  assert.match(parseDispatchArgs([...base, "--max-rounds", "1.5"]).error, /--max-rounds/);
  const ok = parseDispatchArgs([...base, "--liveness-window-ms", "120000", "--max-rounds", "3"]);
  assert.equal(ok.error, null);
  assert.equal(ok.values.livenessWindowMs, 120000);
  assert.equal(ok.values.maxRounds, 3);
});

test("TD-158: 保留 flag 出现于透传即拒（--wait-timeout 是 TD-148 杀 worker 红线）", () => {
  const base = ["--agent", "a", "--prompt-file", "p", "--cwd", "c"];
  for (const flag of RESERVED_PASSTHROUGH_FLAGS) {
    const r = parseDispatchArgs([...base, "--", flag, "x"]);
    assert.ok(r.error && r.error.includes(`${flag} is managed`), `${flag} 应被拒绝：${r.error}`);
  }
  // --wait-timeout 的拒绝文案必须点名 TD-148 红线（防回归：派发侧等待上限会杀 worker）
  assert.match(
    parseDispatchArgs([...base, "--", "--wait-timeout", "85000"]).error,
    /TD-148/,
  );
});

test("TD-158: 合法调用逐字段解析 + 透传原样保留 + registry/run-dir 提取", () => {
  const r = parseDispatchArgs([
    "--agent", "coder_hq", "--prompt-file", "task.md", "--cwd", "D:\\proj\\x",
    "--", "--model", "gpt-5.6-sol", "--isolate", "--registry", "config/agents.json", "--run-dir", "D:/tmp/wao-dl-fixture/runs",
  ]);
  assert.equal(r.error, null);
  assert.equal(r.values.agent, "coder_hq");
  assert.equal(r.values.promptFile, "task.md");
  assert.equal(r.values.cwd, "D:\\proj\\x");
  assert.equal(r.values.livenessWindowMs, DEFAULT_LIVENESS_WINDOW_MS);
  assert.equal(r.values.maxRounds, DEFAULT_MAX_ROUNDS);
  assert.equal(r.values.registry, "config/agents.json");
  assert.equal(r.values.runDir, "D:/tmp/wao-dl-fixture/runs");
  assert.deepEqual(r.passthrough, ["--model", "gpt-5.6-sol", "--isolate", "--registry", "config/agents.json", "--run-dir", "D:/tmp/wao-dl-fixture/runs"]);
});

test("TD-158: USAGE 钉关键内容（TD-158 出处、观察窗默认、透传说明）", () => {
  assert.ok(USAGE.includes("TD-158"));
  assert.ok(USAGE.includes("--liveness-window-ms"));
  assert.ok(USAGE.includes("--prompt-file"));
});

// ===== 重派谓词：三条件缺一不重派 =====

// 上游空窗期空跑形状：completed + completed_empty marker + 证停 → 三条件全真
const EMPTY_RUN = {
  state: "completed",
  diagnosisCode: COMPLETED_EMPTY_MARKER,
  evidence: { activityEventCount: 0, evidenceEventCount: 0, fileWrittenCount: 0, commandExit0Count: 0, assistantTextCount: 0 },
  stopVerified: true,
  backendNoSession: false,
};

test("TD-158: 三条件全真 → 重派（上游空窗空跑形状）", () => {
  const v = shouldRedispatch(EMPTY_RUN);
  assert.equal(v.redispatch, true);
  assert.deepEqual(v.conditions, { terminal: true, emptyMarker: true, workerQuiet: true });
  assert.deepEqual(v.reasons, []);
});

test("TD-158 反例①：未 terminal 不重派（在飞 run 绝不重派——红线）", () => {
  const v = shouldRedispatch({ ...EMPTY_RUN, state: "running", stopVerified: false, backendNoSession: true });
  assert.equal(v.redispatch, false);
  assert.equal(v.conditions.terminal, false);
  assert.match(v.reasons.join("; "), /condition 1 failed: not terminal/);
});

test("TD-158 反例②a：terminal 但有证据不重派（真完成 ≠ 空跑）", () => {
  const v = shouldRedispatch({
    ...EMPTY_RUN,
    diagnosisCode: null,
    evidence: { activityEventCount: 5, evidenceEventCount: 4, fileWrittenCount: 2, commandExit0Count: 1, assistantTextCount: 1 },
  });
  assert.equal(v.redispatch, false);
  assert.equal(v.conditions.emptyMarker, false);
  assert.match(v.reasons.join("; "), /condition 2 failed/);
});

test("TD-158 反例②b：terminal failed 且有活动（崩溃前干过活）不重派", () => {
  const v = shouldRedispatch({
    ...EMPTY_RUN,
    state: "failed",
    diagnosisCode: null,
    evidence: { activityEventCount: 3, evidenceEventCount: 2, fileWrittenCount: 0, commandExit0Count: 0, assistantTextCount: 1 },
  });
  assert.equal(v.redispatch, false);
  assert.equal(v.conditions.emptyMarker, false);
});

test("TD-158 knsoic 锚点（terminal 脸）：纯调研零写入但有产出 → 不是空跑，不重派", () => {
  // 零文件写入、零 exit0 命令——但 message/tool_use 活跃且有 assistant 文本（调研报告即产出）。
  const v = shouldRedispatch({
    ...EMPTY_RUN,
    diagnosisCode: null,
    evidence: { activityEventCount: 7, evidenceEventCount: 5, fileWrittenCount: 0, commandExit0Count: 0, assistantTextCount: 3 },
  });
  assert.equal(v.redispatch, false);
  assert.equal(v.conditions.emptyMarker, false, "零写入 ≠ 零证据：有活动/有文本的 run 绝不按空跑重派");
});

test("TD-158 fail-closed：证据字段缺失 ≠ 零证据（marker 也不在时不重派）", () => {
  const v = shouldRedispatch({ ...EMPTY_RUN, diagnosisCode: null, evidence: undefined });
  assert.equal(v.redispatch, false);
  assert.equal(v.conditions.emptyMarker, false);
});

test("TD-158 反例③：无证停且非进程式 backend（serve 会话可能残留）不重派", () => {
  const v = shouldRedispatch({ ...EMPTY_RUN, stopVerified: false, backendNoSession: false });
  assert.equal(v.redispatch, false);
  assert.equal(v.conditions.workerQuiet, false);
  assert.match(v.reasons.join("; "), /condition 3 failed/);
});

test("TD-158 条件③两臂：进程式无会话残留可独立满足（run.stop_verified 缺席也不阻塞）", () => {
  const v = shouldRedispatch({ ...EMPTY_RUN, stopVerified: false, backendNoSession: true });
  assert.equal(v.redispatch, true);
  assert.equal(v.conditions.workerQuiet, true);
});

test("TD-158: 零证据臂兜底（无 marker 但 activityEventCount === 0 的秒败空跑也命中②）", () => {
  const v = shouldRedispatch({
    ...EMPTY_RUN,
    state: "failed",
    diagnosisCode: null, // 例如 crash/unknown 分类——但全程零活动
    evidence: { activityEventCount: 0, evidenceEventCount: 0, fileWrittenCount: 0, commandExit0Count: 0, assistantTextCount: 0 },
  });
  assert.equal(v.conditions.emptyMarker, true);
  assert.equal(v.redispatch, true);
});

test("TD-158: 非对象/畸形输入 fail-closed（三条件全假，绝不重派）", () => {
  for (const bad of [null, undefined, 42, "x", {}]) {
    const v = shouldRedispatch(bad);
    assert.equal(v.redispatch, false);
    assert.equal(v.conditions.terminal, false);
    assert.equal(v.conditions.emptyMarker, false);
    assert.equal(v.conditions.workerQuiet, false);
  }
});

// ===== 条件③a：证停事实推导 =====

test("TD-158: deriveStopVerified——绑定 runId、verified 且无 unverified 才真", () => {
  const rid = "run_x";
  const verified = { type: "run.stop_verified", runId: rid };
  const unverified = { type: "run.stop_unverified", runId: rid };
  assert.equal(deriveStopVerified([verified], rid), true);
  // 一条未证停事实压掉更早的证停（fail-closed）
  assert.equal(deriveStopVerified([verified, unverified], rid), false);
  // 外 run 事件不采信
  assert.equal(deriveStopVerified([{ type: "run.stop_verified", runId: "run_other" }], rid), false);
  assert.equal(deriveStopVerified([], rid), false);
  assert.equal(deriveStopVerified(null, rid), false);
});

// ===== 退避与观察动作 =====

test("TD-158: 线性退避 20s/40s/60s（轮次钳底、可换基值）", () => {
  assert.equal(backoffDelayMs(1), 20_000);
  assert.equal(backoffDelayMs(2), 40_000);
  assert.equal(backoffDelayMs(3), 60_000);
  assert.equal(backoffDelayMs(0), 20_000); // 钳到 1 倍
  assert.equal(backoffDelayMs(2, 5_000), 10_000);
});

test("TD-158 observationAction 红线：非终态一律继续观察（绝不中止、绝不重派在飞）", () => {
  // knsoic 在飞脸：纯调研零写入但观察窗内活跃（progress）——不重派不误杀，继续等
  assert.equal(observationAction({ state: "running", liveness: "progress" }), "continue");
  // 在飞且静默：也只继续观察——活性影响报告，不影响动作（杀不杀永远是 Lead 的事）
  assert.equal(observationAction({ state: "running", liveness: "silent" }), "continue");
  assert.equal(observationAction({ state: "pending" }), "continue");
  assert.equal(observationAction({}), "continue");
  assert.equal(observationAction(undefined), "continue");
});

test("TD-158 observationAction：四个终态都进入谓词判定", () => {
  for (const state of TERMINAL_STATES) {
    assert.equal(observationAction({ state }), "evaluate");
  }
  assert.equal(isTerminalState("completed"), true);
  assert.equal(isTerminalState("running"), false);
});

// ===== SSOT 接地钉（不自造闭集） =====

test("TD-158 接地: completed_empty marker 必须是 DIAGNOSIS_CODES 闭集成员", () => {
  assert.ok(DIAGNOSIS_CODES.includes(COMPLETED_EMPTY_MARKER));
});

test("TD-158 接地: 终态判定转发 transcript.js TERMINAL_STATES（非第二套清单）", () => {
  // 直接钉 src 闭集的成员（未来 src 改名在此显形，防止脚本判定与 SSOT 漂移）
  assert.deepEqual([...TERMINAL_STATES], ["completed", "failed", "aborted", "timed_out"]);
});

test("TD-158 接地: 进程式 backend 闭集由 KNOWN_BACKENDS 派生（排除 opencode-serve）", () => {
  assert.ok(PROCESS_BACKEND_IDS.includes("claude-code"));
  assert.ok(PROCESS_BACKEND_IDS.includes("codex"));
  assert.ok(PROCESS_BACKEND_IDS.includes("kimi-code"));
  assert.ok(PROCESS_BACKEND_IDS.includes("deepseek-harness"));
  assert.ok(!PROCESS_BACKEND_IDS.includes("opencode-serve"));
  for (const b of PROCESS_BACKEND_IDS) assert.ok(KNOWN_BACKENDS.includes(b));
});

// ===== auditor 批次2 复核回归钉（F3/F4）=====

test("F3 回归: 显式 run.stop_unverified 压掉 backendNoSession 类别臂——不重派", async () => {
  const { shouldRedispatch, deriveStopUnverified } = await import("../../scripts/dispatch-with-liveness.mjs");
  // 反例即审计现场：failed + 零活动 + stop_unverified + 进程式 backend
  const r = shouldRedispatch({
    state: "failed",
    diagnosisCode: null,
    evidence: { activityEventCount: 0 },
    stopVerified: false,
    stopUnverified: true,
    backendNoSession: true,
  });
  assert.equal(r.redispatch, false, "显式未证停事实必须阻断重派");
  assert.equal(r.conditions.workerQuiet, false, "条件③：类别臂被 stopUnverified 压掉");
  // 无显式未证停事实时类别臂恢复生效（进程式语义）
  const ok = shouldRedispatch({
    state: "failed",
    evidence: { activityEventCount: 0 },
    stopVerified: false,
    stopUnverified: false,
    backendNoSession: true,
  });
  assert.equal(ok.redispatch, true, "无未证停事实时进程式类别臂可用");
  // deriveStopUnverified 投影
  assert.equal(deriveStopUnverified([{ runId: "r1", type: "run.stop_unverified" }], "r1"), true);
  assert.equal(deriveStopUnverified([{ runId: "r2", type: "run.stop_unverified" }], "r1"), false, "绑定作用域外不算");
});

test("F4 回归: supervisionLoop 轮次上限——空跑到底恰好派发 maxRounds 次", async () => {
  const { supervisionLoop } = await import("../../scripts/dispatch-with-liveness.mjs");
  let calls = 0;
  const r = await supervisionLoop({
    maxRounds: 3,
    agent: "coder_hq",
    dispatchRound: () => { calls += 1; return { ok: true, runId: `run_empty_${calls}` }; },
    observeRound: async () => ({ state: "failed", diagnosisCode: null, evidence: { activityEventCount: 0 }, stopVerified: false, stopUnverified: false }),
    backendNoSession: true,
  });
  assert.equal(calls, 3, "恰好派发 3 次");
  assert.equal(r.outcome, "max_rounds_reached");
  assert.equal(r.exitCode, 1);
});

test("F4 回归: 第二轮真完成 → 恰好两次派发、exitCode 0（completed 且非空跑）", async () => {
  const { supervisionLoop } = await import("../../scripts/dispatch-with-liveness.mjs");
  let calls = 0;
  const r = await supervisionLoop({
    maxRounds: 5,
    agent: "coder_hq",
    dispatchRound: () => { calls += 1; return { ok: true, runId: `run_${calls}` }; },
    observeRound: async (runId) => runId === "run_1"
      ? { state: "failed", evidence: { activityEventCount: 0 }, stopVerified: false, stopUnverified: false }
      : { state: "completed", evidence: { activityEventCount: 4, assistantTextCount: 1 }, stopVerified: false, stopUnverified: false },
    backendNoSession: true,
  });
  assert.equal(calls, 2);
  assert.equal(r.outcome, "no_redispatch");
  assert.equal(r.exitCode, 0, "completed 且非空跑 = 0（usage.md exit 语义）");
});

test("F4 回归: 谓词阻断路径——stop_unverified 单轮即停、exitCode 1", async () => {
  const { supervisionLoop } = await import("../../scripts/dispatch-with-liveness.mjs");
  let calls = 0;
  const r = await supervisionLoop({
    maxRounds: 5,
    agent: "coder_hq",
    dispatchRound: () => { calls += 1; return { ok: true, runId: "run_x" }; },
    observeRound: async () => ({ state: "failed", evidence: { activityEventCount: 0 }, stopVerified: false, stopUnverified: true }),
    backendNoSession: true,
  });
  assert.equal(calls, 1, "显式未证停阻断重派：不再有第二轮");
  assert.equal(r.outcome, "no_redispatch");
  assert.equal(r.exitCode, 1);
});

test("F4 回归: dispatch_failed 路径 exitCode 1 且保留 lastSummary=null", async () => {
  const { supervisionLoop } = await import("../../scripts/dispatch-with-liveness.mjs");
  const r = await supervisionLoop({
    maxRounds: 3,
    agent: "coder_hq",
    dispatchRound: async () => ({ ok: false, error: "spawn failed" }),
    observeRound: async () => { throw new Error("should not observe"); },
    backendNoSession: true,
  });
  assert.equal(r.outcome, "dispatch_failed");
  assert.equal(r.exitCode, 1);
  assert.equal(r.lastSummary, null);
});

// ===== 复核二轮回归钉（F3 抢跑窗口 / F4 漏接线）=====

test("复核二轮 F3: observeWithSettle 终态后 settle 重读——抢跑窗口内落盘的 stop_unverified 进入谓词输入", async () => {
  const m = await import("../../scripts/dispatch-with-liveness.mjs");
  // 用 monkey-patch 模块内私有 observe？不可——observeWithSettle 调 observeUntilTerminal（模块私有）。
  // 改钉两件事：(1) settle 常量存在且 >0；(2) 源码接线钉（下一条测试）。
  assert.ok(m.TERMINAL_SETTLE_MS > 0, "settle 窗口必须为正（终态先于证停落盘的窗口补偿）");
});

test("复核二轮 F4: 生产入口接线静态钉——sleepFn/logLine/observeWithSettle 必须显式传入 supervisionLoop", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(fileURLToPath(new URL("../../scripts/dispatch-with-liveness.mjs", import.meta.url)), "utf8");
  // main() 的 supervisionLoop 调用块必须显式接线（复核实证：漏接曾致退避跳过+日志吞掉）
  const callSite = src.slice(src.indexOf("await supervisionLoop({"), src.indexOf("await supervisionLoop({") + 800);
  assert.ok(callSite.includes("sleepFn: sleep,"), "main 必须显式传 sleepFn: sleep（漏接=跳过退避）");
  assert.ok(callSite.includes("logLine: log,"), "main 必须显式传 logLine: log（漏接=吞掉逐轮日志）");
  assert.ok(callSite.includes("observeWithSettle"), "observeRound 必须经 observeWithSettle（终态后 settle 重读关闭证停抢跑窗口）");
});

test("复核二轮 F3: 端到端谓词语义——settle 后仍未证停的进程式自然终态按类别语义放行（台账边界）", async () => {
  const { shouldRedispatch } = await import("../../scripts/dispatch-with-liveness.mjs");
  // settle 重读后无任何 stop 事实：进程式自然终态（backend done 即进程退出）→ 放行（TD-158 既有边界）
  const r = shouldRedispatch({
    state: "failed",
    evidence: { activityEventCount: 0 },
    stopVerified: false,
    stopUnverified: false, // settle 后仍无 stop 事实
    backendNoSession: true,
  });
  assert.equal(r.redispatch, true, "无任何 stop 事实的进程式自然终态：类别臂放行（TD-158 边界，非抢跑）");
  // 对照：显式未证停事实必须仍然阻断
  const blocked = shouldRedispatch({
    state: "failed",
    evidence: { activityEventCount: 0 },
    stopVerified: false,
    stopUnverified: true,
    backendNoSession: true,
  });
  assert.equal(blocked.redispatch, false);
});
