// test/registry-roles/reliabilityDrills.test.js
//
// ADR-0032 §6：drill glue 抽取（scripts/run-reliability.mjs → scripts/reliability/drills.mjs）
// 的结构钉 + 纯 glue 行为钉。
//
// 覆盖面：
//   1. drills.mjs 可独立 import 且导出齐全（纯 glue 顶层导出 + createDrills 工厂）；
//   2. glue 未被复制——run-reliability.mjs 源码不再有这些函数的内联定义（防回归钉）；
//   3. 依赖注入钉——drills.mjs 不复制入口环境常量（NODE_BIN/ROOT/TMP_DIR/... 只经 DI）；
//   4. 纯 glue 语义钉（hasSentinel/inferState/hasMonotonicSeq/extractJson/check/
//      waitForTranscript——钉住抽取时行为零漂移）；
//   5. readRunEvents 的 DI 接线行为钉（默认 runDir 从注入的 tmpDir 派生）；
//   6. child_process 导入纪律钉（TD-69 同款，钉随调用迁至 drills.mjs）。
//
// 真实 token 消耗的派发不在本文件（同 reliabilityDelta.test.js 先例：dry 形状）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractJson,
  check,
  hasSentinel,
  waitForTranscript,
  inferState,
  hasMonotonicSeq,
  createDrills,
} from "../../scripts/reliability/drills.mjs";
import { scorecardCommandFailureIsCredible } from "../../scripts/reliability/scorecardEvidence.mjs";

// ════ 1. 独立 import + 导出齐全 ════

test("drills.mjs 可独立 import 且纯 glue 顶层导出齐全", () => {
  assert.equal(typeof extractJson, "function");
  assert.equal(typeof check, "function");
  assert.equal(typeof hasSentinel, "function");
  assert.equal(typeof waitForTranscript, "function");
  assert.equal(typeof inferState, "function");
  assert.equal(typeof hasMonotonicSeq, "function");
  assert.equal(typeof createDrills, "function", "工厂是环境依赖 glue 的唯一装配面");
});

test("createDrills 返回全部环境依赖 drill glue（组合入口与将来组件入口共用的面）", () => {
  const drills = createDrills({
    nodeBin: process.execPath,
    root: process.cwd(),
    tmpDir: process.cwd(),
    waitTimeout: "1000",
    pollInterval: "10",
    registry: "fixture-agents.json",
  });
  const EXPECTED = [
    "runCli",
    "runStrictScorecardDrill",
    "runIsolationDrill",
    "runAdversarialEscapeDrill",
    "runWorkflowRunDirDrill",
    "runStopDrill",
    "runFileScorecardTask",
    "ensureTmpGitRepo",
    "readRunEvents",
  ];
  for (const name of EXPECTED) {
    assert.equal(typeof drills[name], "function", `工厂必须提供 ${name}`);
  }
});

test("createDrills【证伪】: 缺环境依赖必须 fail fast（不得静默 undefined 潜进派发参数）", () => {
  assert.throws(() => createDrills({}), /nodeBin/, "缺第一个必填依赖即红");
  const partial = { nodeBin: "node", root: "r", tmpDir: "t", waitTimeout: "1", pollInterval: "1" };
  assert.throws(() => createDrills(partial), /registry/);
  assert.throws(() => createDrills({ ...partial, registry: null }), /registry/, "null 同样是缺依赖");
});

// ════ 2. glue 未被复制（防回归钉——ADR-0032 §6 防双轨漂移）════

// 抽取清单：任务列明的 9 个函数 + 随迁的依赖助手（runCli 的支撑函数）。
const MOVED_GLUE_NAMES = [
  "runCli",
  "extractJson",
  "hasSentinel",
  "check",
  "runStrictScorecardDrill",
  "runIsolationDrill",
  "runAdversarialEscapeDrill",
  "runWorkflowRunDirDrill",
  "runStopDrill",
  "runFileScorecardTask",
  "ensureTmpGitRepo",
  "readRunEvents",
  "waitForTranscript",
  "inferState",
  "hasMonotonicSeq",
];

test("源级钉: run-reliability.mjs 不再内联定义任何 drill glue（复制即双轨，当场红）", () => {
  const entry = readFileSync(new URL("../../scripts/run-reliability.mjs", import.meta.url), "utf8");
  for (const name of MOVED_GLUE_NAMES) {
    const defRe = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*=)`);
    assert.ok(!defRe.test(entry), `run-reliability.mjs 不得内联定义 ${name}（glue 单一来源 = drills.mjs）`);
  }
  // 接线：从共享模块 import 工厂并装配（解构形式不算内联定义）。
  assert.match(entry, /import\s*\{[^}]*\bcreateDrills\b[^}]*\}\s*from\s*"\.\/reliability\/drills\.mjs"/s,
    "组合入口必须从 ./reliability/drills.mjs import 工厂");
  const wiring = entry.match(/const\s*\{([^}]*)\}\s*=\s*createDrills\(/s);
  assert.ok(wiring, "组合入口必须解构装配 createDrills(...) 的返回值");
  for (const name of ["runCli", "runStrictScorecardDrill", "runIsolationDrill", "runAdversarialEscapeDrill", "runWorkflowRunDirDrill", "runStopDrill"]) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(wiring[1]), `组合入口必须接线 drill：${name}`);
  }
  // 主流程仍消费的纯 glue 也从共享模块 import（不留本地副本）。
  assert.match(entry, /import\s*\{[^}]*\bextractJson\b[^}]*\bcheck\b[^}]*\bhasSentinel\b[^}]*\}\s*from\s*"\.\/reliability\/drills\.mjs"/s);
});

// ════ 3. 依赖注入钉（drills.mjs 不复制入口环境常量——那是新的双源）════

test("源级钉: drills.mjs 不复制入口环境常量，环境只经 createDrills 显式注入", () => {
  const glue = readFileSync(new URL("../../scripts/reliability/drills.mjs", import.meta.url), "utf8");
  for (const name of ["NODE_BIN", "ROOT", "TMP_DIR", "WAIT_TIMEOUT", "POLL_INTERVAL", "REGISTRY"]) {
    assert.ok(!new RegExp(`(?:const|let|var)\\s+${name}\\b`).test(glue),
      `drills.mjs 不得自定义 ${name}（入口常量的第二份定义 = 双源漂移）`);
  }
  // 不得自派生仓库根（import.meta.url/fileURLToPath 是 ROOT 的另一条推导路径）。
  assert.ok(!glue.includes("fileURLToPath"), "drills.mjs 不得自派生路径（root 必须注入）");
  assert.ok(!glue.includes("import.meta.url"), "drills.mjs 不得读 import.meta.url（root 必须注入）");
  // runCli 的派发面必须消费注入标识符（nodeBin/root），不是任何全局或常量。
  assert.match(glue, /spawnSync\(nodeBin,\s*\[resolve\(root,\s*"src",\s*"cli\.js"\)/,
    "runCli 必须用注入的 nodeBin + root 定位 CLI");
});

// ════ 4. 纯 glue 语义钉（抽取时行为零漂移的 dry 证明）════

test("hasSentinel: sentinel 必须由 assistant 回显承载（ADR-0032 §8 修复——搜所有 message 的旧坏模式已收严）", () => {
  const result = {
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "read the file" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "got ALPHA_X1" }] },
    ],
  };
  assert.equal(hasSentinel(result, "ALPHA_X1"), true, "嵌在 assistant text 里的 sentinel 能命中");
  assert.equal(hasSentinel(result, "ALPHA_X9"), false, "不在场的不命中");
  assert.equal(hasSentinel({ messages: [] }, "ALPHA_X1"), false);
  assert.equal(hasSentinel({}, "ALPHA_X1"), false, "无 messages → false（不抛）");
  // 【证伪】只在非 assistant 消息里出现（tool_result 投影 / 用户消息回显）不算命中
  //——读文件 ≠ 回显：回包里搜到不构成模型消费了该值的证据。
  const toolResultOnly = {
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "read sent_a.txt whose content is ALPHA_X1" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
    ],
  };
  assert.equal(hasSentinel(toolResultOnly, "ALPHA_X1"), false, "sentinel 只在 user 消息/工具投影里 → 不命中");
  const assistantNonText = {
    messages: [
      { info: { role: "assistant" }, parts: [{ type: "tool_use", name: "Read" }] },
    ],
  };
  assert.equal(hasSentinel(assistantNonText, "ALPHA_X1"), false, "assistant 的非 text part 不承载回显");
});

test("inferState: 末条 state_change 胜出；legacy fact 事件按 aborted/completed/timed_out/failed 兜底", () => {
  const ev = (type, extra = {}) => ({ type, ...extra });
  assert.equal(inferState([ev("run.started"), ev("run.state_change", { to: "aborted" }), ev("run.state_change", { to: "failed" })]), "failed",
    "最后一条 state_change 胜出");
  assert.equal(inferState([ev("run.stop_requested")]), "aborted");
  assert.equal(inferState([ev("run.aborted")]), "aborted");
  assert.equal(inferState([ev("run.completed")]), "completed");
  assert.equal(inferState([ev("run.timed_out")]), "timed_out");
  assert.equal(inferState([ev("run.error")]), "failed");
  assert.equal(inferState([]), "pending");
  assert.equal(inferState([ev("run.event", { kind: "message" })]), "pending");
});

test("hasMonotonicSeq: 严格递增 true；相等/回退 false；非数字 seq 跳过", () => {
  assert.equal(hasMonotonicSeq([{ seq: 1 }, { seq: 2 }, { seq: 5 }]), true);
  assert.equal(hasMonotonicSeq([{ seq: 2 }, { seq: 2 }]), false, "相等即非单调");
  assert.equal(hasMonotonicSeq([{ seq: 3 }, { seq: 1 }]), false);
  assert.equal(hasMonotonicSeq([{ seq: 1 }, { kind: "no-seq" }, { seq: 2 }]), true, "无 seq 事件不参与判定");
  assert.equal(hasMonotonicSeq([]), true, "空事件流视为单调");
});

test("extractJson: 整块 JSON 直解；混杂输出取首尾大括号切片；不可解析 → null", () => {
  assert.deepEqual(extractJson('{"completed":true}\n'), { completed: true });
  assert.deepEqual(extractJson('noise before {"runId":"r1"} trailing'), { runId: "r1" });
  assert.equal(extractJson("not json at all"), null);
  assert.equal(extractJson(""), null);
});

test("check: 形状钉——pass 布尔化、detail 保留、extra 展开且可覆盖默认键", () => {
  const c = check("completed", 1, "core", "completed=true", { capability: "complete" });
  assert.deepEqual(c, { name: "completed", pass: true, category: "core", detail: "completed=true", capability: "complete" });
  assert.equal(check("x", 0, "core", "d").pass, false, "falsy 强制布尔化为 false");
  assert.equal(check("x", undefined, "core", "d").pass, false);
});

test("waitForTranscript: 文件在场即 true；超时且不在场为 false（timeoutMs=0 不睡眠）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-drills-wft-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run_ok.jsonl"), '{"type":"run.started"}\n');
    assert.equal(waitForTranscript(dir, "run_ok", 0), true, "文件已存在 → true（零等待路径）");
    assert.equal(waitForTranscript(dir, "run_missing", 0), false, "超时且文件不存在 → false");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ════ 5. readRunEvents 的 DI 接线行为钉 ════

test("readRunEvents: 默认 runDir 从注入的 tmpDir 派生；显式 runDir 优先；缺失文件为空数组", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-drills-rre-"));
  try {
    const runsDir = join(dir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "run_x.jsonl"), '{"type":"run.started","seq":1}\n{"type":"run.completed","seq":2}\n');
    const drills = createDrills({
      nodeBin: process.execPath, root: dir, tmpDir: dir,
      waitTimeout: "1000", pollInterval: "10", registry: "fixture.json",
    });
    // 默认 runDir = join(tmpDir, "runs")——证明注入的 tmpDir 真实生效（非文档性断言）。
    assert.deepEqual(drills.readRunEvents("run_x").map((e) => e.type), ["run.started", "run.completed"]);
    // 显式 runDir 优先。
    assert.deepEqual(drills.readRunEvents("run_x", runsDir).length, 2);
    // 缺失文件 → []（fail-open 读取语义与抽取前一致）。
    assert.deepEqual(drills.readRunEvents("nope"), []);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ════ 6. ADR-0032 §8 五态批次源级钉（2026-09-21）════

test("源级钉: runStrictScorecardDrill 文件证据 = 存在 + 内容承载 sentinel（不再只查存在）", () => {
  const glue = readFileSync(new URL("../../scripts/reliability/drills.mjs", import.meta.url), "utf8");
  assert.match(glue, /fileContentMatches/, "drill 返回内容比对事实");
  assert.match(glue, /includes\(fileSentinel\)/, "内容判定 = sentinel 在场（includes）");
});

test("源级钉: run-reliability 无 completed 顶替 / 无 silentPass 顶绿；commandsPassed 按声明条件化", () => {
  const entry = readFileSync(new URL("../../scripts/run-reliability.mjs", import.meta.url), "utf8");
  // 坏模式 5：缺 scorecard 用 completed 顶替 → 现在必须是红（固定文案在场）。
  assert.doesNotMatch(entry, /check\("commandsPassed", completed/, "completed 顶替形状必须消失");
  assert.match(entry, /completed-substitution is forbidden/, "缺 scorecard 记红的固定文案在场");
  // 交付项 4：commandsPassed 按 reportsCommandExitCode 声明条件化（N/A）。
  assert.match(entry, /reportsCommandExitCode/, "条件化判定源（backendCapabilitySnapshot）在场");
  assert.match(entry, /naCheck\(\s*"commandsPassed"/, "declared=false ⇒ commandsPassed 记 N/A");
  assert.match(entry, /scorecardCommandFailureIsCredible\(observedCommandsCheck\)/,
    "declared=false 仍须保留 scorecard 已明确观察到的真实非零退出失败");
  // 坏模式 2：silentTimeout serve 不可达不再写通过。
  assert.doesNotMatch(entry, /silentPass = true/, "skip 顶绿必须消失");
  assert.match(entry, /naCheck\(\s*"silentTimeout"/, "serve 不可达记 N/A + 原因");
  // 坏模式 4：fileMaterialized 消费内容比对事实。
  assert.match(entry, /fileContentMatches/, "fileMaterialized 判定消费内容比对");
  // 五态判定：case pass 状态感知（N/A 不算失败也不置绿）。
  assert.match(entry, /checkStateOf/, "入口消费五态派生");
});

test("F11: command capability declaration preserves credible fail and only N/A-maps unavailable evidence", () => {
  assert.equal(scorecardCommandFailureIsCredible({
    name: "commandsPassed", passed: false, detail: "failed (exitCode!=0): npm test (exitCode=7)",
  }), true, "an observed numeric nonzero exit is a real failure");
  assert.equal(scorecardCommandFailureIsCredible({
    name: "commandsPassed", passed: false, exitCode: 3,
  }), true, "a structured nonzero exit is a real failure");
  assert.equal(scorecardCommandFailureIsCredible({
    name: "commandsPassed", passed: false, detail: "failed (exitCode!=0): npm test (exitCode=undefined)",
  }), false, "missing exit-code evidence remains unavailable rather than a quality failure");
  assert.equal(scorecardCommandFailureIsCredible(null), false);
});

// ════ 7. child_process 导入纪律钉（TD-69 同款，随调用迁至 drills.mjs）════

test("drills.mjs 调用 child_process API 时必须显式导入（TD-69 教训随 glue 迁移）", () => {
  const glue = readFileSync(new URL("../../scripts/reliability/drills.mjs", import.meta.url), "utf8");
  if (/\bexecFileSync\s*\(/.test(glue)) {
    assert.match(glue, /import\s*\{[^}]*\bexecFileSync\b[^}]*\}\s*from\s*"node:child_process"/s,
      "drills.mjs 调用 execFileSync 时必须显式导入，避免 isolation drill 在真实 gate 才失败");
  }
  if (/\bspawnSync\s*\(/.test(glue)) {
    assert.match(glue, /import\s*\{[^}]*\bspawnSync\b[^}]*\}\s*from\s*"node:child_process"/s,
      "drills.mjs 调用 spawnSync 时必须显式导入");
  }
});
