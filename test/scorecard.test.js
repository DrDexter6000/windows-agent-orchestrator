import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkScorecard } from "../src/scorecard.js";

/**
 * scorecard 读 transcript 事件数组（含 run.event 类型的证据事件）。
 * run.event 形态：{ type:"run.event", kind:"command", command, exitCode? } 等。
 * run.completed 形态：{ type:"run.completed" }
 */

function ev(kind, extra = {}) {
  return { type: "run.event", kind, ...extra };
}

test("M6-5: 无 rules → passed:true（opt-in 语义，不拦）", async () => {
  const events = [{ type: "run.completed" }];
  const result = await checkScorecard({ events, cwd: ".", rules: {} });
  assert.equal(result.passed, true);
  assert.ok(Array.isArray(result.checks));
});

test("M6-5: 无 doneEvent (无 run.completed) → hasDoneEvent 失败", async () => {
  const events = [ev("command", { command: "echo hi", exitCode: 0 })];
  const result = await checkScorecard({ events, cwd: ".", rules: {} });
  assert.equal(result.passed, false);
  const doneCheck = result.checks.find((c) => c.name === "hasDoneEvent");
  assert.ok(doneCheck);
  assert.equal(doneCheck.passed, false);
});

test("M6-5: requireCommands 命令跑了且 exitCode=0 → 通过", async () => {
  const events = [
    { type: "run.completed" },
    ev("command", { command: "npm test", exitCode: 0 }),
  ];
  const result = await checkScorecard({
    events, cwd: ".",
    rules: { requireCommands: ["npm test"] },
  });
  assert.equal(result.passed, true);
  const cmdCheck = result.checks.find((c) => c.name === "commandsPassed");
  assert.ok(cmdCheck.passed);
});

test("M6-5: Claude Bash command 无 exitCode 但关联 tool_result 成功 → 通过", async () => {
  const events = [
    { type: "run.completed" },
    ev("command", { command: "node --version", toolCallId: "call_1" }),
    ev("tool_result", { tool: "call_1", output: "v24.13.1", isError: false }),
  ];
  const result = await checkScorecard({
    events, cwd: ".",
    rules: { requireCommands: ["node --version"], requireEvidence: true },
  });
  assert.equal(result.passed, true);
  const cmdCheck = result.checks.find((c) => c.name === "commandsPassed");
  assert.ok(cmdCheck.passed);
});

test("M6-5: Claude Bash command 关联 tool_result 失败 → requireCommands 失败", async () => {
  const events = [
    { type: "run.completed" },
    ev("command", { command: "node --version", toolCallId: "call_1" }),
    ev("tool_result", { tool: "call_1", output: "not found", isError: true }),
  ];
  const result = await checkScorecard({
    events, cwd: ".",
    rules: { requireCommands: ["node --version"] },
  });
  assert.equal(result.passed, false);
  const cmdCheck = result.checks.find((c) => c.name === "commandsPassed");
  assert.equal(cmdCheck.passed, false);
  assert.match(cmdCheck.detail, /exitCode/);
});

test("M6-5: requireCommands 命令没跑 → 失败，detail 标注缺哪个", async () => {
  const events = [
    { type: "run.completed" },
    ev("command", { command: "echo hi", exitCode: 0 }),
  ];
  const result = await checkScorecard({
    events, cwd: ".",
    rules: { requireCommands: ["npm test"] },
  });
  assert.equal(result.passed, false);
  const cmdCheck = result.checks.find((c) => c.name === "commandsPassed");
  assert.equal(cmdCheck.passed, false);
  assert.match(cmdCheck.detail, /npm test/);
});

test("M6-5: requireCommands 命令跑了但 exitCode=1 → 失败", async () => {
  const events = [
    { type: "run.completed" },
    ev("command", { command: "npm test", exitCode: 1 }),
  ];
  const result = await checkScorecard({
    events, cwd: ".",
    rules: { requireCommands: ["npm test"] },
  });
  assert.equal(result.passed, false);
  const cmdCheck = result.checks.find((c) => c.name === "commandsPassed");
  assert.equal(cmdCheck.passed, false);
  assert.match(cmdCheck.detail, /exitCode/);
});

test("M6-5: requireCommands 包含匹配（npm test 匹配 'npm test --verbose'）", async () => {
  const events = [
    { type: "run.completed" },
    ev("command", { command: "npm test --verbose", exitCode: 0 }),
  ];
  const result = await checkScorecard({
    events, cwd: ".",
    rules: { requireCommands: ["npm test"] },
  });
  assert.equal(result.passed, true);
});

test("M6-5: requireFiles file_written 有且文件存在 → 通过", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-sc-"));
  try {
    await writeFile(join(dir, "result.js"), "export default 1;");
    const events = [
      { type: "run.completed" },
      ev("file_written", { path: "result.js" }),
    ];
    const result = await checkScorecard({
      events, cwd: dir,
      rules: { requireFiles: ["result.js"] },
    });
    assert.equal(result.passed, true);
    const fileCheck = result.checks.find((c) => c.name === "filesExist");
    assert.ok(fileCheck.passed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-5: requireFiles file_written 有但文件不存在 → 失败", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-sc-"));
  try {
    const events = [
      { type: "run.completed" },
      ev("file_written", { path: "result.js" }),
    ];
    const result = await checkScorecard({
      events, cwd: dir,
      rules: { requireFiles: ["result.js"] },
    });
    assert.equal(result.passed, false);
    const fileCheck = result.checks.find((c) => c.name === "filesExist");
    assert.equal(fileCheck.passed, false);
    assert.match(fileCheck.detail, /result.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-5: requireFiles 无 file_written 事件 → 失败", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-sc-"));
  try {
    const events = [{ type: "run.completed" }];
    const result = await checkScorecard({
      events, cwd: dir,
      rules: { requireFiles: ["result.js"] },
    });
    assert.equal(result.passed, false);
    const fileCheck = result.checks.find((c) => c.name === "filesExist");
    assert.equal(fileCheck.passed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filesExist: 无 file_written 事件但文件在磁盘存在 → 通过（方案A，codex command 写文件）", async () => {
  // 真实场景（codex，2026-06-25）：codex 有时用 command_execution（shell）写文件，
  // 不 emit file_written 事件。文件真实写了（磁盘存在），但 file_written 证据缺失。
  // 原逻辑：无 file_written → 直接判 missing → 失败（即使磁盘有文件）。
  // 方案A：无 file_written 时，fallback 查磁盘——文件在 cwd 存在就算通过（任务真完成了）。
  const dir = await mkdtemp(join(tmpdir(), "wao-sc-disk-"));
  try {
    await writeFile(join(dir, "result.js"), "module.exports=1;");
    const events = [{ type: "run.completed" }]; // 无 file_written 事件
    const result = await checkScorecard({
      events, cwd: dir,
      rules: { requireFiles: ["result.js"] },
    });
    const fileCheck = result.checks.find((c) => c.name === "filesExist");
    assert.equal(fileCheck.passed, true, "磁盘存在应作为充分条件（codex command 写文件场景）");
    assert.equal(result.passed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filesExist: 无 file_written 且文件磁盘不存在 → 仍失败（方案A 不放松无文件情况）", async () => {
  // 方案A 不破坏：既无证据又无磁盘文件 → 仍失败（文件真没写）。
  const dir = await mkdtemp(join(tmpdir(), "wao-sc-disk2-"));
  try {
    const events = [{ type: "run.completed" }];
    const result = await checkScorecard({
      events, cwd: dir,
      rules: { requireFiles: ["nonexistent.js"] },
    });
    const fileCheck = result.checks.find((c) => c.name === "filesExist");
    assert.equal(fileCheck.passed, false, "无证据且无磁盘文件应失败");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-5: requireEvidence true + 有 command → 通过", async () => {
  const events = [
    { type: "run.completed" },
    ev("command", { command: "echo hi", exitCode: 0 }),
  ];
  const result = await checkScorecard({
    events, cwd: ".",
    rules: { requireEvidence: true },
  });
  assert.equal(result.passed, true);
});

test("M6-5: requireEvidence true + 无任何证据 → 失败", async () => {
  const events = [{ type: "run.completed" }];
  const result = await checkScorecard({
    events, cwd: ".",
    rules: { requireEvidence: true },
  });
  assert.equal(result.passed, false);
  const evCheck = result.checks.find((c) => c.name === "hasEvidence");
  assert.equal(evCheck.passed, false);
});

test("M6-5: 每条 check 含 name/passed/evidence 三字段", async () => {
  const events = [
    { type: "run.completed" },
    ev("command", { command: "npm test", exitCode: 0 }),
  ];
  const result = await checkScorecard({
    events, cwd: ".",
    rules: { requireCommands: ["npm test"], requireEvidence: true },
  });
  for (const c of result.checks) {
    assert.ok(typeof c.name === "string", "name must be string");
    assert.ok(typeof c.passed === "boolean", "passed must be boolean");
    assert.ok(typeof c.evidence === "string", "evidence must be string");
  }
});

test("M6-5: requireFiles 子目录路径 + 文件存在", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-sc-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "mod.js"), "x");
    const events = [
      { type: "run.completed" },
      ev("file_written", { path: "src/mod.js" }),
    ];
    const result = await checkScorecard({
      events, cwd: dir,
      rules: { requireFiles: ["src/mod.js"] },
    });
    assert.equal(result.passed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-5: 全部规则满足 → passed:true，所有 check passed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-sc-"));
  try {
    await writeFile(join(dir, "out.js"), "1");
    const events = [
      { type: "run.completed" },
      ev("command", { command: "npm test", exitCode: 0 }),
      ev("file_written", { path: "out.js" }),
    ];
    const result = await checkScorecard({
      events, cwd: dir,
      rules: {
        requireCommands: ["npm test"],
        requireFiles: ["out.js"],
        requireEvidence: true,
      },
    });
    assert.equal(result.passed, true);
    assert.ok(result.checks.every((c) => c.passed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-5: requireFiles 绝对路径（claude Write 工具）匹配相对路径 required", async () => {
  // 真实 smoke 抓到的 bug：claude Write 传绝对路径 D:\proj\out.js，
  // requireFiles 写相对路径 "out.js"——必须能匹配（尾部匹配）。
  const dir = await mkdtemp(join(tmpdir(), "wao-sc-"));
  try {
    await writeFile(join(dir, "out.js"), "1");
    const absPath = join(dir, "out.js").replace(/\//g, "\\"); // 模拟 Windows 反斜杠
    const events = [
      { type: "run.completed" },
      ev("file_written", { path: absPath }),
    ];
    const result = await checkScorecard({
      events, cwd: dir,
      rules: { requireFiles: ["out.js"] },
    });
    assert.equal(result.passed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// requireAssistantText（codex 实测建议，纵深防御）
//
// completed 但 assistantTextCount=0 的伪完成：hasDoneEvent 放行，但实际无答案。
// requireAssistantText 检查至少一条 assistant message 含非空 text part。
// ---------------------------------------------------------------------------

test("M6+ requireAssistantText: 有 assistant text 答案 → passed", async () => {
  const events = [
    { type: "run.completed" },
    { type: "run.message", role: "user", parts: [{ type: "text", text: "task" }] },
    { type: "run.message", role: "assistant", parts: [
      { type: "step-start" },
      { type: "text", text: "Here is the answer." },
    ] },
  ];
  const result = await checkScorecard({
    events, cwd: "/tmp",
    rules: { requireAssistantText: true },
  });
  assert.equal(result.passed, true);
  const check = result.checks.find((c) => c.name === "hasAssistantText");
  assert.ok(check && check.passed);
});

test("M6+ requireAssistantText: 只有 tool part 无 text（伪完成）→ not passed", async () => {
  const events = [
    { type: "run.completed" },
    { type: "run.message", role: "assistant", parts: [
      { type: "step-start" },
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "step-finish", reason: "stop" },
    ] },
  ];
  const result = await checkScorecard({
    events, cwd: "/tmp",
    rules: { requireAssistantText: true },
  });
  assert.equal(result.passed, false, "无 assistant text 的 completed 应被 requireAssistantText 拦截");
  const check = result.checks.find((c) => c.name === "hasAssistantText");
  assert.ok(check && !check.passed);
});

test("M6+ requireAssistantText: 无 assistant message → not passed", async () => {
  const events = [
    { type: "run.completed" },
    { type: "run.message", role: "user", parts: [{ type: "text", text: "task" }] },
  ];
  const result = await checkScorecard({
    events, cwd: "/tmp",
    rules: { requireAssistantText: true },
  });
  assert.equal(result.passed, false);
});

test("TD-32: 多条同命令不同 exitCode 时 commandsPassed 取首个匹配（顺序依赖锁定）", async () => {
  // 高并发工具调用可能产生多条同命令的 command 事件（重试、多次调用）。
  // checkCommandsPassed 用 .find() 取首个匹配。本测试锁定该行为：
  // 首个 exitCode=0 → 通过；首个 exitCode!=0 → 失败（即使后续有 exit=0 的同名命令）。
  // 文档化此顺序依赖，防未来重构误改语义。
  const eventsPass = [
    { type: "run.completed" },
    ev("command", { command: "npm test", exitCode: 0 }),
    ev("command", { command: "npm test", exitCode: 1 }), // 重跑失败，但首个匹配是 0
  ];
  const r1 = await checkScorecard({
    events: eventsPass, cwd: ".",
    rules: { requireCommands: ["npm test"] },
  });
  assert.equal(r1.passed, true, "首个匹配 exitCode=0 应通过（即使后续有 exit=1 同名命令）");

  const eventsFail = [
    { type: "run.completed" },
    ev("command", { command: "npm test", exitCode: 1 }), // 首个匹配失败
    ev("command", { command: "npm test", exitCode: 0 }), // 重跑成功，但 find 取首个
  ];
  const r2 = await checkScorecard({
    events: eventsFail, cwd: ".",
    rules: { requireCommands: ["npm test"] },
  });
  assert.equal(r2.passed, false, "首个匹配 exitCode=1 应失败（find 取首个，不看后续）");
});

test("TD-32: tool_result 乱序到达时 exitCode 推断仍正确（按 toolCallId 关联）", async () => {
  // 无 exitCode 的 command 靠 tool_result 推断（withInferredCommandExitCode 按 toolCallId 关联）。
  // 并发场景 tool_result 可能在 command 之后乱序到达——本测试验证关联不依赖事件顺序。
  const events = [
    { type: "run.completed" },
    ev("command", { command: "npm test", toolCallId: "tool_1" }), // 无 exitCode
    ev("tool_result", { tool: "tool_1", isError: false }), // 推断为 exit=0
  ];
  const result = await checkScorecard({
    events, cwd: ".",
    rules: { requireCommands: ["npm test"] },
  });
  assert.equal(result.passed, true, "tool_result isError=false 应推断 exit=0 → 通过");
});

test("TD-32: tool_result isError=true 推断为失败 → commandsPassed 拦截", async () => {
  const events = [
    { type: "run.completed" },
    ev("command", { command: "npm test", toolCallId: "tool_2" }),
    ev("tool_result", { tool: "tool_2", isError: true }),
  ];
  const result = await checkScorecard({
    events, cwd: ".",
    rules: { requireCommands: ["npm test"] },
  });
  assert.equal(result.passed, false, "tool_result isError=true 应推断 exit=1 → 拦截");
});

// ============================================================
// P4 融合项 #4（决策 0011 落地）：requireAcceptance — 用户验收脚本
// ============================================================
// 决策 0011：验收契约 = 用户验收脚本（acceptance script）。与 requireCommands 的关键语义差：
// requireCommands 验 worker 自己跑了什么命令；requireAcceptance 验 worker 干的是对的——
// 由 lead/user 提供独立 oracle 脚本，exit 0 = passed，exit≠0 = failed，detail 透传 stderr。
// 这是 scorecard 的一个新 check，不是替代（与 requireEvidence/requireCommands 同级）。

test("P4-T4: requireAcceptance 脚本 exit 0 → passed（验收脚本通过）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-acceptance-"));
  try {
    // 验收脚本：模拟 lead/user 提供的 oracle（exit 0 = 验收通过）
    const script = join(dir, "verify.mjs");
    await writeFile(script, "process.exit(0);\n");
    const events = [{ type: "run.completed" }];
    const result = await checkScorecard({
      events, cwd: dir,
      rules: { requireAcceptance: "verify.mjs" },
    });
    const acc = result.checks.find((c) => c.name === "acceptance");
    assert.ok(acc, "应有 acceptance check");
    assert.equal(acc.passed, true, "exit 0 = 验收通过");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4-T4: requireAcceptance 脚本 exit≠0 → failed + detail 透传 stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-acceptance-"));
  try {
    const script = join(dir, "verify.mjs");
    await writeFile(script, [
      "process.stderr.write('assertion failed: add(2,3) !== 5\\n');",
      "process.exit(1);",
    ].join("\n"));
    const events = [{ type: "run.completed" }];
    const result = await checkScorecard({
      events, cwd: dir,
      rules: { requireAcceptance: "verify.mjs" },
    });
    const acc = result.checks.find((c) => c.name === "acceptance");
    assert.equal(acc.passed, false, "exit 1 = 验收失败");
    assert.match(acc.detail, /add\(2,3\)/, "detail 透传脚本 stderr");
    assert.equal(result.passed, false, "acceptance 失败 → 整体 passed=false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4-T4: requireAcceptance 脚本抛异常 → failed（非 0 exit）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-acceptance-"));
  try {
    const script = join(dir, "verify.mjs");
    await writeFile(script, "throw new Error('boom');\n");
    const events = [{ type: "run.completed" }];
    const result = await checkScorecard({
      events, cwd: dir,
      rules: { requireAcceptance: "verify.mjs" },
    });
    const acc = result.checks.find((c) => c.name === "acceptance");
    assert.equal(acc.passed, false, "脚本抛错 = exit≠0 = 验收失败");
    assert.match(acc.detail, /boom|exit/i, "detail 含错误信息");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4-T4: 无 requireAcceptance → 不输出 acceptance check（opt-in）", async () => {
  const events = [{ type: "run.completed" }];
  const result = await checkScorecard({ events, cwd: ".", rules: {} });
  assert.equal(result.checks.find((c) => c.name === "acceptance"), undefined, "无规则 = 无 acceptance check");
});
