// cli-runs.test.js
//
// cli.test.js 拆分（TD-138 全量提速批，2026-11-01）——本文件承载 run 派发与
// 读侧面：run --background / 裸 spawn、status scorecard（TD-150 批B）、collect
// （TD-77A / M11-4-B4 --cursor）、R10/R11 model·reasoning 覆盖、R12 retry 继承、
// runs gate（B3）、runs list·wait 窗口与过滤（TD-137 / TD-153）、--isolate /
// --tag 后台全链。共用辅助见 _cliTestHelpers.mjs；用例原样搬运自 cli.test.js
// （数量与断言不变）。

import { test } from "node:test";
import { resolveTranscriptPath, listTranscriptsDeep } from "../../src/projectBuckets.js";
import assert from "node:assert/strict";
import { spawnSync, spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand, statusCommand, collectCommand } from "../../src/cli.js";
import { getRunStatus } from "../../src/application/runStatus.js";
import { readTranscript, findState } from "../../src/transcript.js";
import { spawnCommand } from "../../src/commands/run.js";
import { readRegistry as readRegistryFile } from "../../src/registry.js";
import { retryCommand } from "../../src/commands/lifecycle.js";
import { rmrfRetry } from "../_rmrfHelper.mjs";
import { COMMAND_NAMES, HELP_TEXT } from "../../src/cliHelp.js";
import { captureLog, runCliOnPathNode, makeRetryInheritFixture, parseRetryJson, writeRetrySource } from "./_cliTestHelpers.mjs";

test("P2: 裸 spawn（不带 --wait）路由到 background runner 托管（06-18 架构洞正解）", () => {
  // P0-1 旧护栏（拒绝裸 spawn）已被 P2 替换：现在不拒，而是 fork detached runner 托管。
  // runner 拥有 worker handle，驱动 waitForCompletion（token 闸门/超时/兜底 abort 都生效），
  // 不再产生孤儿 session。这是 06-18 事故架构洞的正解（把"拒绝"换"接管生命周期"）。
  const dir = mkdtempSync(join(tmpdir(), "wao-fireandforget-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bg_worker: {
          backend: "claude-code",
          binary: "nonexistent-binary-p2",
          cwd: dir,
        },
      },
    }), "utf8");
    const runDir = join(dir, "runs");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      "spawn", "bg_worker",
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

    const transcriptPath = resolveTranscriptPath(runDir, parsed.runId);
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

    // b78 续修：--format json 是既有契约（results.md——被接受且与缺省逐字节相同，
    // Lead 与宿主脚本在用），不能报错。WF-6 恢复带旗标调用并钉住逐字节相同。
    // 这里的转录是活的：detached runner 可能恰在两次读取之间落事件——逐字节相同
    // 以"成对读取、至多重试"断言（任一对相同即证两条路径打同一份字节；确定性
    // 逐字节由 b78-line-4 的静态夹具钉）。secondsSince / secondsSinceActivity
    // 是读取时刻算出的秒数，两个子进程之间跨过秒边界就不同（负载高时每对都跨），
    // 比对前把这两个读数归零。
    const steady = (text) => text.replace(/"(secondsSince|secondsSinceActivity)": \d+/g, '"$1": 0');
    const statusSpawn = (extra) => spawnSync(process.execPath, [
      "src/cli.js",
      "status", parsed.runId,
      "--run-dir", runDir,
      ...extra,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });

    let statusJson = null;
    let identical = false;
    let lastPair = null;
    for (let attempt = 0; attempt < 3 && !identical; attempt += 1) {
      const bare = statusSpawn([]);
      assert.equal(bare.status, 0, `status 必须立即可读: ${bare.stderr}`);
      const asJson = statusSpawn(["--format", "json"]);
      assert.equal(asJson.status, 0, `status --format json 必须可用: ${asJson.stderr}`);
      lastPair = { bare: bare.stdout, asJson: asJson.stdout };
      identical = steady(asJson.stdout) === steady(bare.stdout);
    }
    assert.ok(identical,
      `--format json 与不带 --format 输出逐字节相同（3 对读取均不同，最后一对：${JSON.stringify(lastPair)}）`);
    statusJson = JSON.parse(lastPair.asJson);
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

test("P0-1: 裸 spawn 进程式 backend（claude-code/codex）不受护栏限制（进程死即会话死）", () => {
  // 进程式 backend 的 session = 子进程；WAO 进程退出时子进程也会被回收
  // （taskkill /T 兜底 + 进程死即会话死的核心假设）。裸 spawn 对它们是安全的。
  // 护栏不得误伤进程式 backend —— 这是 runtime-agnostic 的体现
  // （护栏按 backend 属性 sessionOutlivesProcess 判定，不按 runtime 名分支）。
  const dir = mkdtempSync(join(tmpdir(), "wao-procsafe-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        codex_worker: {
          backend: "codex",
          binary: "node",
          cwd: dir,
        },
      },
    }), "utf8");
    const runDir = join(dir, "runs");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      "spawn", "codex_worker",
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
    // 注意：worker 可能因 binary 缺失等原因失败，但失败原因不应是 fire-and-forget 护栏。
    assert.ok(!/06-18|fire-and-forget|session.*outlive/i.test(out),
      "进程式 backend 不应被 fire-and-forget 护栏拦截（sessionOutlivesProcess=false）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TD-150 批B（T1 CLI 面）：status 的 Scorecard 一行摘要 ─────────────────
// JSON 块之后恰一行：passed / warn（completed + scorecard 未过 = warn-gate 没
// 拦）/ failed（门拦下）；括号只列检查 name。无 scorecard.checked 不打印——
// 既有纯 JSON 输出逐字节不变（TD-75 系列的 JSON.parse(out) 即 absent 钉）。

// 捕获解析辅助：cli.js import 时自执行的 main()（argv 为测试 runner 参数）会
// 竞态地打印一次 HELP_TEXT（既有 TD-75 系列同受影响，见终报 blocker）。
// statusCommand 的每次 console.log 是捕获数组的一个元素——JSON 块（多行
// pretty-print，整体一个元素）与 Scorecard 行各自成元素，按首字符精确定位即可
// 对该竞态免疫。
async function captureElements(fn) {
  const elements = [];
  const orig = console.log;
  console.log = (...a) => { elements.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return elements;
}
function cliJsonBlock(elements) {
  const blocks = elements.filter((l) => l.startsWith("{"));
  assert.equal(blocks.length, 1, "statusCommand 输出恰一个 JSON 块");
  return JSON.parse(blocks[0]);
}
function cliScorecardLines(elements) {
  return elements.filter((l) => l.startsWith("Scorecard:"));
}

test("TD150B-C1: status warn run —— scorecard 摘要折叠进 JSON（verdict=warn），detail 全输出面零回显", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-sc-warn-"));
  try {
    writeFileSync(join(dir, "run_scw.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-08-24T00:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "completed", ts: "2026-08-24T00:01:00.000Z" }) + "\n" +
      JSON.stringify({
        type: "scorecard.checked", passed: false, ts: "2026-08-24T00:01:00.500Z",
        checks: [
          { name: "hasDoneEvent", passed: true, evidence: "run.completed present" },
          { name: "hasEvidence", passed: false, evidence: "0 evidence event(s) found", detail: "completed_empty: backend produced no model work" },
        ],
      }) + "\n");
    const elements = await captureElements(async () => {
      await statusCommand(["run_scw", "--run-dir", dir], { runDir: dir });
    });
    // 审计修正后：摘要折叠进 JSON 对象；`last` 为 scorecard.checked 时投影为
    // 闭集安全视图——evidence/detail 自由文本全输出面零回显。
    const out = elements.join("\n");
    assert.ok(!out.includes("completed_empty: backend produced no model work"),
      "detail 自由文本零回显（含经 last 字段的旧通道）");
    const parsed = cliJsonBlock(elements);
    assert.deepEqual(parsed.scorecard,
      { verdict: "warn", failedChecks: ["hasEvidence"] },
      "摘要折叠进 JSON：warn-gate completed run 标 warn，括号只列检查名");
    assert.deepEqual(parsed.last,
      { type: "scorecard.checked", passed: false },
      "last 为 scorecard.checked 时投影为闭集安全视图（不带 evidence/detail）");
    assert.ok(!cliScorecardLines(elements).length, "不再有 JSON 块后的独立 Scorecard 行");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD150B-C2: status 全过 scorecard → JSON.scorecard.verdict=passed；门拦下的 failed run → failed + 检查名", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-sc-pass-"));
  try {
    writeFileSync(join(dir, "run_scp.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-08-24T00:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "completed", ts: "2026-08-24T00:01:00.000Z" }) + "\n" +
      JSON.stringify({
        type: "scorecard.checked", passed: true, ts: "2026-08-24T00:01:00.500Z",
        checks: [{ name: "hasDoneEvent", passed: true, evidence: "run.completed present" }],
      }) + "\n");
    const elementsP = await captureElements(async () => {
      await statusCommand(["run_scp", "--run-dir", dir], { runDir: dir });
    });
    const parsedP = cliJsonBlock(elementsP);
    assert.deepEqual(parsedP.scorecard, { verdict: "passed", failedChecks: [] },
      "全过 scorecard → passed 标签、空 failedChecks");

    writeFileSync(join(dir, "run_scf.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-08-24T00:00:00.000Z" }) + "\n" +
      JSON.stringify({
        type: "scorecard.checked", passed: false, ts: "2026-08-24T00:01:00.500Z",
        checks: [{ name: "acceptance", passed: false, evidence: "exit≠0: accept.js", detail: "exit 1: nope" }],
      }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "failed", reason: "scorecard_failed", ts: "2026-08-24T00:01:01.000Z" }) + "\n");
    const elementsF = await captureElements(async () => {
      await statusCommand(["run_scf", "--run-dir", dir], { runDir: dir });
    });
    const parsedF = cliJsonBlock(elementsF);
    assert.deepEqual(parsedF.scorecard, { verdict: "failed", failedChecks: ["acceptance"] },
      "非 completed 形态的门拦下 = failed 标签");
    const outF = elementsF.join("\n");
    assert.ok(!outF.includes("nope") && !outF.includes("accept.js"), "detail/evidence 不回显");

    // 无 scorecard.checked 的 run：无 Scorecard 行（既有纯 JSON 输出不变）。
    writeFileSync(join(dir, "run_scn.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-08-24T00:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-08-24T00:01:02.000Z" }) + "\n");
    const elementsN = await captureElements(async () => {
      await statusCommand(["run_scn", "--run-dir", dir], { runDir: dir });
    });
    const parsedN = cliJsonBlock(elementsN);
    assert.equal("scorecard" in parsedN, false, "无 scorecard 事件 → JSON 字段 absent");
    assert.ok(!cliScorecardLines(elementsN).length, "无摘要行");
  } finally {
    rmrfRetry(dir);
  }
});

// ── b78：status --format line 单行出口 ───────────────────────────────────────
// 显式 --format line 时只打一行，字段取现有 JSON 已打印的字段（值同一快照）；
// 只有 null/缺失写 unknown（空串是事实 ""，照写）；缺省（无 --format）与
// --format json 输出逐字节相同（json 是 results.md 既有契约，WF-6 钉）。

// b78 续修：行尾自由文本字段（lastActivityKind/lastActivitySummary/advisory）的
// 值是 JSON 字符串（带引号与转义，空串 ""）或 unknown——按 JSON 字符串文法逐段
// 解析（不是合法 JSON 字符串也不是 unknown 就红），机器字段是裸 key=value。
const LINE_JSON_STRING_RE = /^"(?:[^"\\]|\\.)*"/;
function readLineFreeText(rest, line) {
  if (rest.startsWith("unknown")) return { value: "unknown", rest: rest.slice("unknown".length) };
  const m = rest.match(LINE_JSON_STRING_RE);
  assert.ok(m, `自由文本字段须为 JSON 字符串或 unknown: ${line}`);
  return { value: JSON.parse(m[0]), rest: rest.slice(m[0].length) };
}
function parseStatusLine(line) {
  const head = line.match(
    /^runId=(\S+) state=(\S+) executionStage=(\S+) secondsSinceActivity=(\S+) observedSeq=(\S+)/,
  );
  assert.ok(head, `机器字段前缀（裸 key=value）: ${line}`);
  const fields = {
    runId: head[1],
    state: head[2],
    executionStage: head[3],
    secondsSinceActivity: head[4],
    observedSeq: head[5],
  };
  let rest = line.slice(head[0].length);
  for (const key of ["lastActivityKind", "lastActivitySummary"]) {
    assert.ok(rest.startsWith(` ${key}=`), `行尾自由文本按序 ${key} 在场: ${line}`);
    const r = readLineFreeText(rest.slice(key.length + 2), line);
    fields[key] = r.value;
    rest = r.rest;
  }
  if (rest.startsWith(" advisory=")) {
    const r = readLineFreeText(rest.slice(" advisory=".length), line);
    fields.advisory = r.value;
    rest = r.rest;
  }
  assert.equal(rest, "", `advisory 之后无残余: ${line}`);
  return fields;
}

test("b78-line-1: --format line 一行、字段齐全，值与缺省 JSON 同一快照", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-line-1-"));
  try {
    // run.event（command）供 lastActivityKind/Summary/secondsSinceActivity；ts 取
    // 当前时刻——非安静 run（<30 分钟），行尾无 advisory，结尾断言确定。
    const now = new Date().toISOString();
    writeFileSync(join(dir, "run_l1.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: now }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "running", ts: now }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "command", command: "npm test", ts: now }) + "\n");
    // 缺省输出：多行 JSON（既有路径），拿它对照单行取值。
    const jsonElements = await captureElements(async () => {
      await statusCommand(["run_l1", "--run-dir", dir], { runDir: dir });
    });
    const parsed = cliJsonBlock(jsonElements);
    assert.equal(parsed.state, "running");
    assert.equal(parsed.lastActivityKind, "跑命令");
    assert.equal(parsed.lastActivitySummary, "npm test");

    const lineElements = await captureElements(async () => {
      await statusCommand(["run_l1", "--run-dir", dir, "--format", "line"], { runDir: dir });
    });
    assert.equal(lineElements.length, 1, "--format line 恰输出一行");
    const line = lineElements[0];
    assert.ok(!line.includes("\n"), "单行不含换行");
    // 自由文本字段的 JSON 字符串形式直接钉在行文里（带引号）。
    assert.ok(line.endsWith('lastActivityKind="跑命令" lastActivitySummary="npm test"'),
      `行尾两个自由文本字段是 JSON 字符串: ${line}`);
    const fields = parseStatusLine(line);
    assert.ok(fields.secondsSinceActivity !== "unknown" && fields.observedSeq !== "unknown",
      "有心跳事件的 run 两个机器字段都有值");
    assert.ok(!("advisory" in fields), "非安静 run 不追加 advisory");
    // 单行取值与缺省 JSON 同一快照（对照断言，不另抄期望）。时间派生字段两次读取
    // 差一秒以内（各自取 now），容差 1。
    assert.equal(fields.runId, parsed.runId);
    assert.equal(fields.state, parsed.state);
    assert.equal(fields.executionStage, parsed.executionStage.phase);
    assert.ok(Math.abs(Number(fields.secondsSinceActivity) - parsed.secondsSinceActivity) <= 1,
      "secondsSinceActivity 与 JSON 同值（±1s 读取间隔）");
    assert.equal(fields.observedSeq, String(parsed.observedSeq));
    assert.equal(fields.lastActivityKind, parsed.lastActivityKind);
    assert.equal(fields.lastActivitySummary, parsed.lastActivitySummary);
  } finally {
    rmrfRetry(dir);
  }
});

test("b78-line-2: 空串摘要照写 \"\"、含空格的 lastActivityKind 带引号（tool_use）——各字段与 JSON 一致", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-line-2-"));
  try {
    // tool_use 且 input 里没有可识别字段：kind=用工具 TaskOutput（含空格）、
    // summary=""（空串）——会审实测的 run_2026100214230874084s9ji 形态。
    const now = new Date().toISOString();
    writeFileSync(join(dir, "run_l2.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: now }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "running", ts: now }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "tool_use", tool: "TaskOutput", input: {}, ts: now }) + "\n");
    const jsonElements = await captureElements(async () => {
      await statusCommand(["run_l2", "--run-dir", dir], { runDir: dir });
    });
    const parsed = cliJsonBlock(jsonElements);
    assert.equal(parsed.lastActivityKind, "用工具 TaskOutput", "夹具前提：kind 含空格");
    assert.equal(parsed.lastActivitySummary, "", "夹具前提：摘要空串（JSON 面 \"\"）");

    const lineElements = await captureElements(async () => {
      await statusCommand(["run_l2", "--run-dir", dir, "--format", "line"], { runDir: dir });
    });
    assert.equal(lineElements.length, 1);
    const line = lineElements[0];
    assert.ok(line.endsWith('lastActivityKind="用工具 TaskOutput" lastActivitySummary=""'),
      `空串摘要是 "" 不是 unknown；含空格的 kind 带引号: ${line}`);
    const fields = parseStatusLine(line);
    assert.equal(fields.lastActivityKind, parsed.lastActivityKind);
    assert.equal(fields.lastActivitySummary, parsed.lastActivitySummary);
    assert.equal(fields.runId, parsed.runId);
    assert.equal(fields.state, parsed.state);
    assert.equal(fields.executionStage, parsed.executionStage.phase);
    assert.equal(fields.observedSeq, String(parsed.observedSeq));
    assert.ok(Math.abs(Number(fields.secondsSinceActivity) - parsed.secondsSinceActivity) <= 1);
  } finally {
    rmrfRetry(dir);
  }
});

test("b78-line-3: null/缺失写 unknown（无 run.event）；advisory 有则行尾追加、无则不追加", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-line-3-"));
  try {
    // 只有提交与状态事件：lastActivityKind/Summary/secondsSinceActivity 全 null →
    // unknown。两份 fixture 钉死 advisory 两个分支：ts=1 小时前（未终态 → 必安静
    // → 有 advisory）与 ts=当前（必不安静 → 无）。
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const now = new Date().toISOString();
    for (const [runId, ts] of [["run_l3q", hourAgo], ["run_l3n", now]]) {
      writeFileSync(join(dir, `${runId}.jsonl`),
        JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts }) + "\n" +
        JSON.stringify({ type: "run.state_change", to: "running", ts }) + "\n");
    }
    const line = (runId) => captureElements(async () => {
      await statusCommand([runId, "--run-dir", dir, "--format", "line"], { runDir: dir });
    });
    const quietElements = await line("run_l3q");
    assert.equal(quietElements.length, 1);
    const quietFields = parseStatusLine(quietElements[0]);
    assert.equal(quietFields.secondsSinceActivity, "unknown", "无 run.event → secondsSinceActivity unknown");
    assert.equal(quietFields.lastActivityKind, "unknown", "null kind → unknown");
    assert.equal(quietFields.lastActivitySummary, "unknown", "null summary → unknown");
    assert.ok(typeof quietFields.advisory === "string", "安静 run 行尾追加 advisory");
    const jsonQuiet = await captureElements(async () => {
      await statusCommand(["run_l3q", "--run-dir", dir], { runDir: dir });
    });
    const parsedQuiet = cliJsonBlock(jsonQuiet);
    assert.ok(typeof parsedQuiet.advisory === "string", "夹具前提：1 小时无动作的未终态 run 必有 advisory");
    assert.equal(quietFields.advisory, parsedQuiet.advisory, "advisory 解析后与 JSON 同值");

    const freshElements = await line("run_l3n");
    assert.equal(freshElements.length, 1);
    const freshFields = parseStatusLine(freshElements[0]);
    assert.ok(!("advisory" in freshFields), "不安静不追加 advisory");
    assert.ok(freshElements[0].endsWith("lastActivityKind=unknown lastActivitySummary=unknown"),
      "null 自由文本写 unknown（无引号）收尾");
  } finally {
    rmrfRetry(dir);
  }
});

test("b78-line-4: 缺省与 --format json 逐字节相同（in-process 静态夹具）；未知/缺值 --format 报错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-line-4-"));
  try {
    // 静态夹具：恰一条 run.submitted（ts=当前时刻）——无状态事件（executionStage
    // phase unknown、secondsSince null）无 run.event（心跳 null）且不安静（无
    // advisory）。所有字段不随墙钟走，两次读取逐字节相同是确定性的。
    writeFileSync(join(dir, "run_l4.jsonl"),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: new Date().toISOString() }) + "\n");
    const bare = await captureElements(async () => {
      await statusCommand(["run_l4", "--run-dir", dir], { runDir: dir });
    });
    const asJson = await captureElements(async () => {
      await statusCommand(["run_l4", "--run-dir", dir, "--format", "json"], { runDir: dir });
    });
    assert.equal(bare.length, 1, "缺省仍恰一个输出块");
    assert.deepEqual(asJson, bare, "--format json 与缺省输出逐字节相同（静态夹具，确定性）");
    assert.ok(bare[0].startsWith("{\n"), "缺省输出是多行 JSON 块");
    assert.equal(JSON.stringify(JSON.parse(bare[0]), null, 2), bare[0], "JSON 块自洽（无行模式残留）");
    assert.ok(!bare[0].startsWith("runId="), "缺省不是单行格式");
    // 未知值 / 缺值：沿用 collect 投影面的 fail-fast 文案风格（json|line 是闭集）。
    await assert.rejects(
      () => statusCommand(["run_l4", "--run-dir", dir, "--format", "text"], { runDir: dir }),
      /status: --format only supports json\|line/,
    );
    await assert.rejects(
      () => statusCommand(["run_l4", "--run-dir", dir, "--format"], { runDir: dir }),
      /status: --format requires a value/,
    );
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
// R16 夹具诚实化（TD-128 夹具纪律）：session.created/run.started/终态行补 runId
// 信封（对齐 writeM11_4CliTranscript 与 M9-4A-12 形状——runCollect 的会话查找自
// R16 起是 runId 绑定读取，无信封行不可见会误触发"无会话元数据"拒绝）；首行
// run.submitted 保持无 runId 的既有 TD-77 形状（与 M9-4A-12 同款首行宽容）。
function writeProcRunTranscript(dir, runId, runEventLines) {
  writeFileSync(join(dir, `${runId}.jsonl`),
    JSON.stringify({ type: "run.submitted", agentId: "researcher", ts: "2026-06-28T20:33:52.000Z" }) + "\n" +
    JSON.stringify({ type: "session.created", backend: "process", backendSessionId: "proc_4242", runId, agentId: "researcher" }) + "\n" +
    JSON.stringify({ type: "run.started", backend: "claude-code", ts: "2026-06-28T20:33:53.000Z", runId, agentId: "researcher" }) + "\n" +
    runEventLines +
    JSON.stringify({ type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-06-28T20:35:00.000Z", runId, agentId: "researcher" }) + "\n" +
    JSON.stringify({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-28T20:35:00.000Z", runId, agentId: "researcher" }) + "\n");
}

test("TD-77A: 失败 run 无最终 message 但有证据事件 → collect 重建非空（含各 kind）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-collect-fail-"));
  try {
    // 模拟 codex e2e run_20260628203352049lf1n0l：崩前有 tool_use/tool_result/
    // file_written，但无最终 assistant message → 旧 collect 返回 data:[]。
    writeProcRunTranscript(dir, "run_collect_fail",
      JSON.stringify({ type: "run.event", kind: "command", command: "rg TODO", exitCode: 0, ts: "2026-06-28T20:34:05.000Z", runId: "run_collect_fail", agentId: "researcher" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "tool_use", tool: "Read", input: { file_path: "src/app.py" }, ts: "2026-06-28T20:34:10.000Z", runId: "run_collect_fail", agentId: "researcher" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "tool_result", tool: "Read", output: "def main():...", isError: false, ts: "2026-06-28T20:34:11.000Z", runId: "run_collect_fail", agentId: "researcher" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "file_written", path: "D:/proj/report.md", ts: "2026-06-28T20:34:30.000Z", runId: "run_collect_fail", agentId: "researcher" }) + "\n");
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
      JSON.stringify({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }], ts: "2026-06-28T20:34:20.000Z", runId: "run_collect_msg", agentId: "researcher" }) + "\n");
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
// Shared per-call target for the MCP run_collect parity call (the real
// service verifies ownership; the fixture carries this root as run.started cwd).
const MCP_TARGET = (() => {
  const d = mkdtempSync(join(tmpdir(), "wao-cli-mcp-target-"));
  execSync("git init -q", { cwd: d, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: d, stdio: "pipe" });
  execSync("git config user.name T", { cwd: d, stdio: "pipe" });
  writeFileSync(join(d, "README.md"), "# t", "utf8");
  execSync("git add README.md", { cwd: d, stdio: "pipe" });
  execSync("git commit -q -m init", { cwd: d, stdio: "pipe" });
  return d;
})();

function writeM11_4CliTranscript(dir, runId, messageBodies) {
  const lines = [
    JSON.stringify({ type: "run.submitted", agentId: "researcher", ts: "2026-07-22T00:00:00.000Z" }),
    JSON.stringify({ type: "session.created", backend: "process", backendSessionId: "proc_m114_cli", runId, agentId: "researcher" }),
    JSON.stringify({ type: "run.started", backend: "claude-code", ts: "2026-07-22T00:00:01.000Z", runId, agentId: "researcher", cwd: MCP_TARGET }),
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
      const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_cli_parity", expectedWorkspaceRoot: MCP_TARGET } });
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
  // TD-260（0062 B8）：双向关系——HELP_TEXT 的每个两空格命令行首词（完整 token，
  // 审核修订：`^  (\S+)` 捕全词——数字/下划线/大写等非 [a-z-] 首词的旧行正则会
  // 静默漏掉）必须在本闭集（TD-250 加 serve 用法行时漏了成员，单向守卫对此
  // 失明——与 TD-257 backend 计数派生守卫同型教训：双向关系派生守卫必须双向钉）。
  // 例外：`  - ` 起头的列表项行（HELP_TEXT 的子弹行）不是命令行。
  for (const m of HELP_TEXT.matchAll(/^  (\S+)(\s|$)/gm)) {
    if (/^-(\s|$)/.test(m[1])) continue;
    assert.ok(
      COMMAND_NAMES.includes(m[1]),
      `HELP_TEXT command line "${m[1]}" missing from COMMAND_NAMES (bidirectional guard)`,
    );
  }
  // 形状钉（sol/opus 审核条款）：缩进漂移（1/3 空格、tab）会让两个方向的守卫
  // 都失明——命令区每个缩进行的形状必须是"恰两空格+内容"或"4+ 空格续行"。
  for (const line of HELP_TEXT.split("\n")) {
    if (line.trim() === "" || /^\S/.test(line)) continue;
    assert.ok(
      /^  \S/.test(line) || /^ {4,}\S/.test(line),
      `HELP_TEXT indentation anomaly (not 2-space command or 4+ continuation): ${JSON.stringify(line.slice(0, 50))}`,
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

// v0.2.0（决定 0038）：version 命令 + --version 旗标。版本号单一来源是仓库根
// package.json 的 version 字段；CLI 与 MCP serverInfo（SERVER_VERSION）两个
// 消费者必须同源同步——本组测试同时钉住"输出的是同一个值"与"两种问法都在"。
test("v0.2.0: wao version / wao --version 输出 package.json 版本（SSOT 钉）", () => {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"));
  assert.equal(runCliOnPathNode("version").trim(), pkg.version, "wao version 必须原样输出 package.json version");
  assert.equal(runCliOnPathNode("--version").trim(), pkg.version, "wao --version 必须与子命令同值");
});

test("v0.2.0: --version 无 WAO_SKIP_VERSION_GUARD 也可查询（与 help 同类例外，任何环境可答）", () => {
  // 故意不注入 WAO_SKIP_VERSION_GUARD：version 与 help 一样是"用户始终能查"的
  // 入口。在 PATH node 为 v24 的开发机上本测试同时证明 guard 例外；在 v22 上
  // 它至少钉住 exit 0 + 输出形状不回归。
  const res = spawnSync(process.execPath, ["src/cli.js", "--version"], { encoding: "utf8" });
  assert.equal(res.status, 0, `--version 必须 exit 0（stderr: ${res.stderr}）`);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/, "--version 输出必须是裸 semver");
});

test("v0.2.0: WAO_VERSION 与 MCP SERVER_VERSION 同源（package.json 单一来源，两消费者同步）", async () => {
  const { WAO_VERSION } = await import("../../src/version.js");
  const { SERVER_VERSION } = await import("../../src/mcp/server.js");
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"));
  assert.equal(WAO_VERSION, pkg.version);
  assert.equal(SERVER_VERSION, pkg.version, "serverInfo.version 漂移即破坏单一来源声称");
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
    // D2-②b：深层枚举（新 run 转录在 projects/<slug>/ 桶内）。
    const files = listTranscriptsDeep(dir);
    assert.equal(files.length, 1, "one run transcript");
    const events = await readTranscript(files[0].path);
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
    const files = listTranscriptsDeep(dir);
    const events = await readTranscript(files[0].path);
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

// 多 agent spawn 与单 agent 同样经 loadPrompt 读 --prompt / --prompt-file：每个 worker
// 收到同一份任务；两者都没给时报错，不派出没有任务的 worker。
test("spawn 多 agent：--prompt-file 的内容送到每个 worker；没有任务时拒绝派发", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-spawn-multi-prompt-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      a: { backend: "claude-code", cwd: dir },
      b: { backend: "claude-code", cwd: dir },
    } }), "utf8");
    const promptPath = join(dir, "task.txt");
    writeFileSync(promptPath, "line one\nfrom the prompt file", "utf8");
    const prompts = [];
    const backend = {
      supportsRoleContract: true, sessionOutlivesProcess: false,
      async spawn(agent, task) {
        prompts.push(task.prompt);
        return {
          backend: "zcode", backendSessionId: `s-${agent.id}`, messageId: "m1", admittedSeq: 1,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
        };
      },
      defaultBinary() { return "node"; }, credentialEnvNames: () => [],
    };
    const cfg = {
      registry: registryPath,
      runDir: join(dir, "runs"),
      readRegistry: async () => readRegistryFile(registryPath),
      backendFor: () => backend,
      loadLanesConfigFn: () => ({ lanes: [], sha256: null, issues: [], rolesHint: [] }),
    };
    const origLog = console.log;
    console.log = () => {};
    try {
      await spawnCommand(["a", "b", "--prompt-file", promptPath, "--wait"], cfg);
    } finally {
      console.log = origLog;
    }
    assert.equal(prompts.length, 2, "两个 worker 都派出");
    for (const p of prompts) {
      assert.ok(String(p).includes("from the prompt file"), `worker 收到 prompt 文件内容（实得 ${JSON.stringify(p)}）`);
    }
    await assert.rejects(
      () => spawnCommand(["a", "b", "--wait"], cfg),
      /Provide --prompt or --prompt-file/,
    );
    assert.equal(prompts.length, 2, "没有任务时零派发");
  } finally {
    rmrfRetry(dir);
  }
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
    const transcriptPath = resolveTranscriptPath(runDir, parsed.runId);
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
// 布尔——条件子集（kimi K3 / dsh high|max）走
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
    // D2-②b：深层枚举（新 run 转录在 projects/<slug>/ 桶内）。
    const files = listTranscriptsDeep(dir);
    assert.equal(files.length, 1, "one run transcript");
    const events = await readTranscript(files[0].path);
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
    const files = listTranscriptsDeep(dir);
    const events = await readTranscript(files[0].path);
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
  assert.match(out, /only on run and retry \(not\s+spawn\/daemon\)/, "仅 run 与 retry 面（TD-126：retry 自 R12 起接受两 flag）");
  // 旧句反回归：R12 前的过时措辞（漏掉 retry）不得回潮。
  assert.doesNotMatch(out, /only on run \(not\s+spawn\/daemon\)/, "TD-126 旧句不得回潮");
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
    const transcriptPath = resolveTranscriptPath(runDir, parsed.runId);
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
    // 旧 face 的键集 = originalRunId/newRunId/transcript + run.result（backend
    // 句柄序列化字段）。R13-C 夹具诚实化后此处即 ProcessBackend 家族真实键集
    // （messageId/admittedSeq 为 undefined，JSON 序列化丢键）。inheritedOverrides
    // 缺席是字节回归的强钉（键集级而非子串级）。
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["backend", "backendSessionId", "newRunId", "originalRunId", "transcript"],
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
    // 零覆盖放行（?. 链）：不拒绝、无 inheritedOverrides、输出键集与旧 face 一致
    // （R13-C 夹具诚实化后为 ProcessBackend 家族真实键集）。
    assert.ok(!out.includes("inheritedOverrides"));
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["backend", "backendSessionId", "newRunId", "originalRunId", "transcript"],
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

// ===== R23-F/B Round B (TD-130) B3: `runs gate` 出口（只读查询 + 玻璃破断）=====
//
// 闸是机器级的（%LOCALAPPDATA%\wao\verification.lease），用户需要一个不碰真实
// 租约就能回答"现在谁持闸/空闲吗"的出口，以及一个文档在案的人工破锁通道。
// 单测全部注入假 gate（deps.createGate）——绝不触碰真实机器租约文件。

/** 假闸工厂：记录调用，status/breakLock 结果可注入。 */
function fakeGateForCli({ status = { free: true }, breakLockResult = null } = {}) {
  const calls = [];
  return {
    calls,
    acquire: async () => null,
    status: async () => { calls.push("status"); return status; },
    breakLock: async () => { calls.push("breakLock"); return breakLockResult ?? { hadLock: false, released: false }; },
  };
}

test("B3-① runs gate 查询·free：text 报告空闲；JSON 形状 {engaged, lease:{free}}", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const gate = fakeGateForCli({ status: { free: true } });

  const text = await captureLog(() => runsCommand(["gate"], {}, { createGate: () => gate }));
  assert.match(text, /[Ff]ree/, "text 输出必须报告 free");
  assert.deepEqual(gate.calls, ["status"], "只读查询绝不触碰 breakLock");

  const jsonRaw = await captureLog(() => runsCommand(["gate", "--format", "json"], {}, { createGate: () => gate }));
  const parsed = JSON.parse(jsonRaw);
  assert.equal(typeof parsed.engaged, "boolean", "JSON 必须暴露入闸判定状态");
  assert.deepEqual(parsed.lease, { free: true });
});

test("B3-② runs gate 查询·held：text 含持有者身份；JSON holder 字段齐备", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const gate = fakeGateForCli({
    status: {
      free: false,
      holder: {
        owner: "RunManager._verifyDeliveryResult", runId: "run_abc", sessionId: null,
        agentId: "coder_high", pid: 4242, startedAt: 1000, heartbeatAt: 2000, ageMs: 5000,
      },
    },
  });

  const text = await captureLog(() => runsCommand(["gate"], {}, { createGate: () => gate }));
  assert.match(text, /held/i);
  assert.match(text, /RunManager\._verifyDeliveryResult/);
  assert.match(text, /run_abc/);

  const parsed = JSON.parse(await captureLog(() =>
    runsCommand(["gate", "--format", "json"], {}, { createGate: () => gate })));
  assert.equal(parsed.lease.free, false);
  assert.equal(parsed.lease.holder.owner, "RunManager._verifyDeliveryResult");
  assert.equal(parsed.lease.holder.runId, "run_abc");
  assert.equal(parsed.lease.holder.pid, 4242);
  assert.equal(parsed.lease.holder.ageMs, 5000);
});

test("B3-③ runs gate 查询·corrupt：如实报告损坏现场（不粉饰成 free/held）", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const gate = fakeGateForCli({ status: { free: false, corrupt: true, holder: null } });
  const text = await captureLog(() => runsCommand(["gate"], {}, { createGate: () => gate }));
  assert.match(text, /corrupt/i, "损坏租约必须可见");
  const parsed = JSON.parse(await captureLog(() =>
    runsCommand(["gate", "--format", "json"], {}, { createGate: () => gate })));
  assert.equal(parsed.lease.corrupt, true);
  assert.equal(parsed.lease.holder, null);
});

test("B3-④ runs gate 暴露 kill switch 状态：WAO_VERIFICATION_GATE=off ⇒ engaged=false", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const { VERIFICATION_GATE_OFF_ENV } = await import("../../src/verificationGate.js");
  const saved = process.env[VERIFICATION_GATE_OFF_ENV];
  try {
    process.env[VERIFICATION_GATE_OFF_ENV] = "off";
    const parsed = JSON.parse(await captureLog(() =>
      runsCommand(["gate", "--format", "json"], {}, { createGate: () => fakeGateForCli() })));
    assert.equal(parsed.engaged, false, "停用开关必须对用户可见");
    const text = await captureLog(() => runsCommand(["gate"], {}, { createGate: () => fakeGateForCli() }));
    assert.match(text, /off|停用/i, "text 模式也要可见");
  } finally {
    if (saved === undefined) delete process.env[VERIFICATION_GATE_OFF_ENV];
    else process.env[VERIFICATION_GATE_OFF_ENV] = saved;
  }
});

test("B3-④b runs gate 暴露 HELD 继承状态：WAO_VERIFICATION_GATE_HELD=1 ⇒ engaged=false，text 报 disengaged 且不误报 kill switch", async () => {
  // [复审-2 N5] 入闸判定经 gateEngaged/gateDisabled 单一谓词（runs.js 不再手写
  // 第二份 off 判定）。HELD 继承是 disengaged 三分支中此前无钉的一条：kill switch
  // 未关时绝不许误报 "kill switch: active"。
  const { runsCommand } = await import("../../src/commands/runs.js");
  const { VERIFICATION_GATE_HELD_ENV, VERIFICATION_GATE_OFF_ENV } = await import("../../src/verificationGate.js");
  const savedHeld = process.env[VERIFICATION_GATE_HELD_ENV];
  const savedOff = process.env[VERIFICATION_GATE_OFF_ENV];
  try {
    process.env[VERIFICATION_GATE_HELD_ENV] = "1";
    delete process.env[VERIFICATION_GATE_OFF_ENV];
    const parsed = JSON.parse(await captureLog(() =>
      runsCommand(["gate", "--format", "json"], {}, { createGate: () => fakeGateForCli() })));
    assert.equal(parsed.engaged, false, "HELD 继承环境必须对用户可见为不入闸");
    const text = await captureLog(() => runsCommand(["gate"], {}, { createGate: () => fakeGateForCli() }));
    assert.match(text, /disengaged/, "text 必须报告 disengaged（HELD 继承语义）");
    assert.doesNotMatch(text, /kill switch: active/, "kill switch 未关时不得误报 kill switch: active");
  } finally {
    if (savedHeld === undefined) delete process.env[VERIFICATION_GATE_HELD_ENV];
    else process.env[VERIFICATION_GATE_HELD_ENV] = savedHeld;
    if (savedOff === undefined) delete process.env[VERIFICATION_GATE_OFF_ENV];
    else process.env[VERIFICATION_GATE_OFF_ENV] = savedOff;
  }
});

test("B3-⑤ runs gate --release：有锁破除 + 无锁如实告知，两者都 exit 0 语义", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const broke = fakeGateForCli({ breakLockResult: { hadLock: true, released: true } });
  const text = await captureLog(() => runsCommand(["gate", "--release"], {}, { createGate: () => broke }));
  assert.deepEqual(broke.calls, ["breakLock"]);
  assert.match(text, /[Rr]eleased|移除/);

  const none = fakeGateForCli({ breakLockResult: { hadLock: false, released: false } });
  const textNone = await captureLog(() => runsCommand(["gate", "--release"], {}, { createGate: () => none }));
  assert.match(textNone, /no .*lease|nothing/i, "无锁时如实告知，不是错误");

  const parsed = JSON.parse(await captureLog(() =>
    runsCommand(["gate", "--release", "--format", "json"], {},
      { createGate: () => fakeGateForCli({ breakLockResult: { hadLock: true, released: true } }) })));
  assert.equal(parsed.release.hadLock, true);
  assert.equal(parsed.release.released, true);
});

test("B3-⑥ runs gate --release 破锁失败 ⇒ fail-closed 非零退出（抛错）", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  await assert.rejects(
    () => runsCommand(["gate", "--release"], {},
      { createGate: () => fakeGateForCli({ breakLockResult: { hadLock: true, released: false } }) }),
    /failed|无法|remove/i,
    "强制移除失败是真实故障，必须非零退出而不是谎报成功",
  );
});

test("B3-⑦ runs gate 参数纪律：未知 flag 拒绝；positional 拒绝；--format 非法值拒绝", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  await assert.rejects(() => runsCommand(["gate", "--bogus"], {}, { createGate: () => fakeGateForCli() }), /unknown flag/);
  await assert.rejects(() => runsCommand(["gate", "extra"], {}, { createGate: () => fakeGateForCli() }), /takes no|unexpected|positional|argument/i);
  await assert.rejects(() => runsCommand(["gate", "--format", "yaml"], {}, { createGate: () => fakeGateForCli() }), /json\|text/);
});

test("B3-⑧ RUNS_SUBCOMMANDS 收录 gate：unknown-subcommand 错误列出它；HELP_TEXT 含 runs gate 行", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  await assert.rejects(
    () => runsCommand(["gat"], {}, {}),
    (e) => {
      assert.match(e.message, /unknown runs subcommand: gat/);
      assert.match(e.message, /\bgate\b/, "合法子命令清单必须包含 gate");
      return true;
    },
  );
  assert.match(HELP_TEXT, /^  runs gate .+$/m, "帮助页必须有 runs gate 行");
});

// ===== R23-F/B Round B (TD-130) F3: 默认 killProbe 的真子进程实证 =====
//
// R23-F/A 的 A2 单测全部注入 killProbe 假探针；这里用**真实子进程 + 默认探针**
// （process.kill(pid, 0)，无任何注入）实证降级链路的最后一公里：一个刚退出的
// 短命子进程的 pid，在真实进程表里确实探死 ⇒ 孤儿标记打 NOTICE（含 pid）并被接管。
// Windows pid 可能被系统即时复用——每个"新鲜退出"的 pid 试一次，最多 3 个。

test("F3 真子进程实证：默认 killProbe 对刚退出 pid 判 ESRCH ⇒ 孤儿标记 NOTICE 并被接管", async () => {
  const { createInflightMarker, realInflightAdapter, INFLIGHT_MARKER_FILENAME } =
    await import("../../scripts/canonical-test.mjs");

  let sawNoticed = null;
  for (let attempt = 0; attempt < 3 && sawNoticed === null; attempt += 1) {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore", windowsHide: true,
    });
    const pid = child.pid;
    await new Promise((resolve) => child.on("close", resolve));

    const dir = mkdtempSync(join(tmpdir(), "wao-f3-"));
    try {
      // 真实 adapter（显式 tmpdir 路径——绝不触碰机器真实标记文件）+ 真实默认探针。
      const markerPath = join(dir, INFLIGHT_MARKER_FILENAME);
      const adapter = realInflightAdapter(markerPath);
      writeFileSync(markerPath, JSON.stringify({ pid, startedAt: "2026-08-22T00:00:00.000Z" }), "utf8");

      const warnings = [];
      const m = createInflightMarker({ ...adapter, warn: (l) => warnings.push(l), mayTakeOver: true });
      const outcome = m.begin();
      const noticed = warnings.find((l) => l.includes("NOTICE") && l.includes(`pid ${pid}`) && l.includes("ESRCH"));
      if (noticed) {
        sawNoticed = { pid, outcome, line: noticed };
        assert.equal(JSON.parse(readFileSync(markerPath, "utf8")).pid, process.pid, "接管后文件里是本进程的标记");
      } else if (outcome !== "observed") {
        throw new Error(`attempt ${attempt}: expected observed, got ${outcome}; warnings=${JSON.stringify(warnings)}`);
      }
      // 接管后标记归本次删除；pid 被复用（探活为活）时按观察者处理、不删别人的标记。
      assert.equal(m.end(), Boolean(noticed), noticed ? "接管后的标记归本次删除" : "观察者绝不删除他人标记");
      if (noticed) assert.equal(existsSync(markerPath), false, "退出后标记文件已删");
    } finally {
      rmrfRetry(dir);
    }
  }
  assert.ok(sawNoticed,
    "3 个新鲜退出 pid 全部被复用（病理性环境）——降级链路未能实证，请在该环境复核 pid 复用率");
  assert.equal(sawNoticed.outcome, "created");
  assert.match(sawNoticed.line, /stale inflight marker/);
});

// ===== TD-137 四件套批次（CLI friction 正式批次）=====
//
// ① 裸 `runs list` 默认最新优先（updatedAt desc；服务默认序直达用户，不再恢复
//    文件名升序）。② 三个等待上限的交叉提示（数值零变更）：到期返回附一行
//    advisory 文案，MCP 适配层显式键集合不透传，合同形状零变更。
// ③ runId 内嵌时间戳为 UTC 的双通道文档补充。④ allowedPaths 接受目录条目
//    （写路径入口归一化至多一个结尾斜杠；matcher 与 workdir_escape 零改动）。

/**
 * TD-137① 前置排水：本文件顶部 import 了 src/cli.js，其底部无条件
 * `main(process.argv.slice(2))` 在测试进程里也会启动——runner 子进程的 argv
 * 为空/help 形状时它会在若干个事件轮次后 printHelp()。若该续体恰好落在某个
 * captureLog 窗口内，捕获输出就被 HELP_TEXT 污染（JSON.parse 炸）。
 * 这里先让出事件轮次把它排干，再开任何捕获窗口。
 */
async function drainStrayCliMain() {
  await new Promise((r) => setTimeout(r, 50));
}

/** TD-137① 夹具：写一个最小 run transcript（首事件带 agentId，末事件 ts 即 updatedAt）。 */
function writeTd137ListFixture(runDir, runId, lastTs) {
  const events = [
    { seq: 1, ts: "2026-08-23T00:00:00.000Z", type: "run.started", runId, agentId: "coder_low", backend: "claude-code" },
    { seq: 2, ts: lastTs, type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "running", reason: "activity" },
  ];
  writeFileSync(join(runDir, `${runId}.jsonl`),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

test("TD-137① 裸 runs list 默认最新优先：updatedAt 新的在前（text + json），不再文件名升序", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-td137-list-"));
  try {
    await drainStrayCliMain();
    // 判别性夹具：字典序更小的 run_aaa 反而更旧——旧行为升序会把它排第一。
    writeTd137ListFixture(dir, "run_aaa", "2026-08-23T00:01:00.000Z");
    writeTd137ListFixture(dir, "run_bbb", "2026-08-23T02:00:00.000Z");

    const text = await captureLog(() => runsCommand(["list", "--run-dir", dir], {}));
    const bIdx = text.indexOf("run_bbb");
    const aIdx = text.indexOf("run_aaa");
    assert.ok(bIdx !== -1 && aIdx !== -1, "两个 run 都要列出");
    assert.ok(bIdx < aIdx, "裸 list 必须最新优先：run_bbb（新）在 run_aaa（旧）之前");

    const parsed = JSON.parse(await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--format", "json"], {})));
    assert.deepEqual(parsed.runs.map((r) => r.runId), ["run_bbb", "run_aaa"],
      "JSON 模式同一排序（listRuns 服务 updatedAt desc 直达）");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-137① --latest N 截取与全量排序不变（updatedAt desc，无信封 run 由末事件 ts 兜底推导）", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-td137-latest-"));
  try {
    await drainStrayCliMain();
    writeTd137ListFixture(dir, "run_old", "2026-08-23T00:01:00.000Z");
    writeTd137ListFixture(dir, "run_new", "2026-08-23T02:00:00.000Z");
    // legacy 无信封事件（无 runId）→ updatedAt 由末事件 ts 兜底推导；夹具取
    // 最旧值使其如实殿后（排序语义：updatedAt desc，无 null 特例参与本测）。
    writeFileSync(join(dir, "run_legacy.jsonl"),
      `${JSON.stringify({ seq: 1, ts: "2026-08-22T00:00:00.000Z", type: "run.started", agentId: "x" })}\n`,
      "utf8");

    const rawLatest = await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--latest", "1", "--format", "json"], {}));
    assert.match(rawLatest, /^\s*\{/, `输出应为 JSON，got: ${rawLatest.slice(0, 160)}`);
    const latest1 = JSON.parse(rawLatest);
    assert.deepEqual(latest1.runs.map((r) => r.runId), ["run_new"], "--latest 1 只取最新一条");

    const all = JSON.parse(await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--format", "json"], {})));
    assert.deepEqual(all.runs.map((r) => r.runId), ["run_new", "run_old", "run_legacy"],
      "全量：updatedAt desc、null 殿后（服务既有语义，CLI 不再翻转）");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-137② buildWaitWindowHint 单一构造处：自带上限 + 同族三上限齐备", async () => {
  const { buildWaitWindowHint, RUN_WAIT_MAX_MS } = await import("../../src/application/runWait.js");
  const { DELIVERY_WAIT_MS_MAX } = await import("../../src/application/runDelivery.js");
  const { RUN_AWAIT_RESULT_MAX_MS } = await import("../../src/application/runAwaitResult.js");
  for (const cap of [RUN_WAIT_MAX_MS, DELIVERY_WAIT_MS_MAX, RUN_AWAIT_RESULT_MAX_MS]) {
    const hint = buildWaitWindowHint(cap);
    assert.match(hint, new RegExp(`本命令上限 ${cap}ms`), "必须如实标注本命令自己的上限");
    assert.match(hint, /观察窗到期非终态/, "先讲清非终态事实（不是卡死/失败）");
    assert.match(hint, /同族：runs wait 600000 \/ delivery waitMs ≤300000 \/ await-result ≤270000/,
      "三个同族上限全部在场（数值零变更，只做交叉指路）");
  }
});

test("TD-137②-a: WAIT_FAMILY_CAPS 提示文案与三上限常量一致（防漂移钉：改常量不改文案必红）", async () => {
  const { buildWaitWindowHint, RUN_WAIT_MAX_MS } = await import("../../src/application/runWait.js");
  const { DELIVERY_WAIT_MS_MAX } = await import("../../src/application/runDelivery.js");
  const { RUN_AWAIT_RESULT_MAX_MS } = await import("../../src/application/runAwaitResult.js");
  const hint = buildWaitWindowHint(RUN_WAIT_MAX_MS);
  // 审计指出：文案里是字面量数值，未插值常量——本钉保证任一常量调整而文案
  // 未同步时必红（SSOT 数值防漂移）。
  assert.match(hint, new RegExp(`runs wait ${RUN_WAIT_MAX_MS}`), "runs wait 上限须与导出常量一致");
  assert.match(hint, new RegExp(`delivery waitMs ≤${DELIVERY_WAIT_MS_MAX}`), "delivery 上限须与导出常量一致");
  assert.match(hint, new RegExp(`await-result ≤${RUN_AWAIT_RESULT_MAX_MS}`), "await-result 上限须与导出常量一致");
});

/** TD-137② 夹具：非终态/终态最小 transcript（m12-11-wait-services 同款事件序列）。 */
function writeTd137RunTranscript(runDir, runId, terminal) {
  const a = "coder_low";
  const events = [
    { type: "run.submitted", agentId: a, ts: "2026-08-23T00:00:00.000Z", runId },
    { type: "session.created", backend: "process", backendSessionId: "proc_td137", runId, agentId: a },
    { type: "run.started", backend: "claude-code", ts: "2026-08-23T00:00:01.000Z", runId, agentId: a },
    { type: "run.state_change", to: "pending", reason: "created", ts: "2026-08-23T00:00:02.000Z", runId, agentId: a },
    { type: "run.state_change", to: "running", reason: "first_event", ts: "2026-08-23T00:00:03.000Z", runId, agentId: a },
  ];
  if (terminal) {
    events.push(
      { type: "run.completed", ts: "2026-08-23T00:10:00.000Z", runId, agentId: a },
      { type: "run.state_change", to: "completed", reason: "done", ts: "2026-08-23T00:10:01.000Z", runId, agentId: a },
    );
  }
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${runId}.jsonl`),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

test("TD-137② runWait 服务：窗口到期（非终态）带 waitWindowHint；终态提前返回不带", async () => {
  const { runWait, RUN_WAIT_MAX_MS } = await import("../../src/application/runWait.js");
  const runDir = mkdtempSync(join(tmpdir(), "wao-td137-rd-"));
  try {
    writeTd137RunTranscript(runDir, "run_td137w", false);
    writeTd137RunTranscript(runDir, "run_td137done", true);
    let t = 1000000;
    const inject = { nowFn: () => t, pollIntervalMs: RUN_WAIT_MAX_MS, sleepFn: async (ms) => { t += ms; } };

    const out = await runWait({ runId: "run_td137w", runDir, waitMs: RUN_WAIT_MAX_MS, ...inject });
    assert.equal(out.terminal, false);
    assert.equal(out.returnedEarly, false, "窗口耗尽路径（非提前返回）");
    assert.match(out.waitWindowHint, /本命令上限 600000ms/, "runs wait 自身上限");
    assert.match(out.waitWindowHint, /delivery waitMs ≤300000/, "同族：delivery 上限在场");
    assert.match(out.waitWindowHint, /await-result ≤270000/, "同族：await-result 上限在场");

    const term = await runWait({ runId: "run_td137done", runDir, waitMs: RUN_WAIT_MAX_MS, ...inject });
    assert.equal(term.terminal, true);
    assert.equal("waitWindowHint" in term, false, "终态结果不是观察窗到期，不带提示");
  } finally {
    rmrfRetry(runDir);
  }
});

test("TD-137② getRunDeliveryReadiness 服务：deadline 到期（非终态）带提示；提前返回不带", async () => {
  const { getRunDeliveryReadiness, DELIVERY_WAIT_MS_MAX } = await import("../../src/application/runDelivery.js");
  const runDir = mkdtempSync(join(tmpdir(), "wao-td137-dlv-rd-"));
  try {
    const runId = "run_td137d";
    const ref = {
      schemaVersion: 1, kind: "git_commit", runId,
      baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
      branch: `wao/${runId}`, worktreePath: "/fake/wt", changedFiles: ["src/a.js"],
      verification: { status: "pending", commands: [], verifiedCommit: "d".repeat(40), results: [] },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    };
    let seq = 0;
    const line = (p) => JSON.stringify({ ts: "2026-08-23T00:00:00.000Z", seq: (seq += 1), ...p });
    // delivery 已请求但未打包 → 整个窗口保持 waiting_*，走 deadline 到期路径。
    writeFileSync(join(runDir, `${runId}.jsonl`), [
      line({ type: "run.started", runId, delivery: { mode: "git_commit_v1" }, worktreePath: "/fake/wt" }),
      line({ type: "run.delivery_created", runId, delivery: ref }),
    ].join("\n") + "\n", "utf8");
    let clock = 1000000;
    const r = await getRunDeliveryReadiness({
      runId, runDir, waitMs: 1000,
      nowFn: () => clock, sleepFn: async (ms) => { clock += ms; }, pollIntervalMs: 600,
    });
    assert.equal(r.waitReturnedEarly, false, "deadline 到期路径");
    assert.match(r.waitWindowHint, new RegExp(`本命令上限 ${DELIVERY_WAIT_MS_MAX}ms`),
      "delivery wait 自身上限");
    assert.match(r.waitWindowHint, /runs wait 600000/, "同族：runs wait 上限在场");

    // 对照：not_requested 立即返回（提前返回，不是收口判定）→ 无提示字段。
    const plainId = "run_td137plain";
    writeFileSync(join(runDir, `${plainId}.jsonl`),
      line({ type: "run.started", runId: plainId, backend: "claude-code" }) + "\n", "utf8");
    clock = 2000000;
    const settled = await getRunDeliveryReadiness({
      runId: plainId, runDir, waitMs: 1000,
      nowFn: () => clock, sleepFn: async (ms) => { clock += ms; }, pollIntervalMs: 600,
    });
    assert.equal(settled.readiness, "not_requested");
    assert.equal(settled.waitReturnedEarly, true);
    assert.equal("waitWindowHint" in settled, false, "提前返回不是观察窗到期，不带提示");
  } finally {
    rmrfRetry(runDir);
  }
});

test("TD-137② runAwaitResult 服务：窗口到期（非终态）带 waitWindowHint（自身上限 270000）", async () => {
  const { runAwaitResult, RUN_AWAIT_RESULT_MAX_MS } = await import("../../src/application/runAwaitResult.js");
  const runDir = mkdtempSync(join(tmpdir(), "wao-td137-ar-rd-"));
  try {
    writeTd137RunTranscript(runDir, "run_td137a", false);
    let t = 1000000;
    const inject = { nowFn: () => t, pollIntervalMs: RUN_AWAIT_RESULT_MAX_MS, sleepFn: async (ms) => { t += ms; } };
    const out = await runAwaitResult({ runId: "run_td137a", runDir, waitMs: RUN_AWAIT_RESULT_MAX_MS, ...inject });
    assert.equal(out.terminal, false);
    assert.equal(out.observationOutcome, "observed");
    assert.match(out.waitWindowHint, new RegExp(`本命令上限 ${RUN_AWAIT_RESULT_MAX_MS}ms`));
    assert.match(out.waitWindowHint, /runs wait 600000/, "同族：runs wait 上限在场");
    assert.match(out.waitWindowHint, /delivery waitMs ≤300000/, "同族：delivery 上限在场");
  } finally {
    rmrfRetry(runDir);
  }
});

test("TD-137② runs wait CLI：text 在五行摘要后追加 Hint 行（原行结构不动）；json 透出 waitWindowHint", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const { buildWaitWindowHint, RUN_WAIT_MAX_MS } = await import("../../src/application/runWait.js");
  const fakeService = async () => ({
    runId: "run_hint", agentId: "coder_low", state: "running",
    terminal: false, cursor: 5, returnedEarly: false,
    observationOutcome: "observed", readFailureReason: null,
    liveness: "active", activityEventCount: 1, lastActivityKind: "run.event",
    ownerHeartbeat: "unknown",
    observation: { waitedMs: 600000, windowMs: 600000, outcome: "window_expired" },
    termination: null,
    waitWindowHint: buildWaitWindowHint(RUN_WAIT_MAX_MS),
  });
  const out = await captureLog(() =>
    runsCommand(["wait", "run_hint", "--wait-ms", "600000", "--run-dir", "."], {}, { runWaitFn: fakeService }));
  const lines = out.split("\n");
  const obsIdx = lines.findIndex((l) => l.startsWith("Observation:"));
  assert.ok(obsIdx !== -1, "五行摘要结构保持（Observation 行在场）");
  assert.equal(lines[1], "Terminal: no", "到期非终态事实照旧");
  assert.match(lines[obsIdx + 1], /^Hint: 观察窗到期非终态；本命令上限 600000ms；同族：/,
    "Hint 行紧随 Observation 之后（追加式，不位移既有行）");

  const parsed = JSON.parse(await captureLog(() =>
    runsCommand(["wait", "run_hint", "--wait-ms", "600000", "--format", "json", "--run-dir", "."],
      {}, { runWaitFn: fakeService })));
  assert.equal(typeof parsed.waitWindowHint, "string", "CLI json 是完整服务结果投影，字段透出");
  assert.ok(Array.isArray(parsed.semanticNotes), "semanticNotes selector 照旧");
});

test("TD-137② runs delivery --wait-ms CLI：到期打印 Hint；提前返回不打印", async () => {
  const { runsDeliveryCommand } = await import("../../src/commands/runs.js");
  const expired = async () => ({
    runId: "run_dh", terminalState: "running", readiness: "waiting_for_packaging",
    waitReturnedEarly: false, deliveryAvailable: false, deliveryRequested: true,
    deliveryFailure: null, isolationFailure: null, verification: null,
    effectiveVerification: null, reverify: null, acceptance: null,
    waitWindowHint: `观察窗到期非终态；本命令上限 300000ms；同族：runs wait 600000 / delivery waitMs ≤300000 / await-result ≤270000`,
  });
  const out = await captureLog(() =>
    runsDeliveryCommand(["run_dh", "--wait-ms", "1000", "--run-dir", "."], {}, { getRunDeliveryReadinessFn: expired }));
  assert.match(out, /\(wait expired\)/);
  assert.match(out, /^Hint: 观察窗到期非终态；本命令上限 300000ms；同族：/m, "到期输出附带同族上限提示");

  const settled = async () => ({
    runId: "run_dh2", terminalState: "completed", readiness: "reviewable",
    waitReturnedEarly: true, deliveryAvailable: true,
    deliveryRef: { deliveryCommit: "d".repeat(40) }, deliveryRequested: true,
    deliveryFailure: null, isolationFailure: null,
    verification: { status: "passed" }, effectiveVerification: null, reverify: null,
    acceptance: { status: "pending" },
  });
  const outSettled = await captureLog(() =>
    runsDeliveryCommand(["run_dh2", "--wait-ms", "1000", "--run-dir", "."], {}, { getRunDeliveryReadinessFn: settled }));
  assert.match(outSettled, /^Readiness: reviewable \(returned early\)$/m);
  assert.doesNotMatch(outSettled, /^Hint: /m, "提前返回不是观察窗到期，无 Hint 行");

  // 决定 0095：提前返回不是收口判定——仍在跑的 run、重读失败的 ambiguous 也提前返回，
  // 都不能标成 settled（收口由 runs wait --until-settled 判定）。
  for (const [runId, terminalState, readiness] of [
    ["run_dh3", "running", "not_requested"],
    ["run_dh4", "completed", "ambiguous"],
  ]) {
    const early = async () => ({
      runId, terminalState, readiness,
      waitReturnedEarly: true, deliveryAvailable: false, deliveryRequested: readiness !== "not_requested",
      deliveryFailure: null, isolationFailure: null, verification: null,
      effectiveVerification: null, reverify: null, acceptance: null,
    });
    const out = await captureLog(() =>
      runsDeliveryCommand([runId, "--wait-ms", "1000", "--run-dir", "."], {}, { getRunDeliveryReadinessFn: early }));
    assert.match(out, new RegExp(`^Readiness: ${readiness} \\(returned early\\)$`, "m"));
    assert.doesNotMatch(out, /settled/, `${readiness}：不标成 settled`);
  }
});

test("TD-137④ 写路径接受目录条目：尾斜杠归一化、混合清单、精确文件不变、非法形状照拒且回显原始输入", async () => {
  const { prepareDeliveryRequest, isPathAllowed } = await import("../../src/delivery.js");
  const base = {
    mode: "git_commit_v1", agentId: "coder_low", workspaceRoot: "D:/tmp/wt",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    changedFiles: ["src/a.js"], verificationCommands: ["npm test"],
  };
  // 目录条目（含尾斜杠）到达段边界 matcher；持久化契约为归一化后的无斜杠形状。
  const withDir = prepareDeliveryRequest({ ...base, allowedPaths: ["src/", "docs/guide.md"] });
  assert.deepEqual(withDir.allowedPaths, ["docs/guide.md", "src"], "尾斜杠归一化 + 排序");
  const dedup = prepareDeliveryRequest({ ...base, allowedPaths: ["src/", "src"] });
  assert.deepEqual(dedup.allowedPaths, ["src"], "同义目录条目去重为一条");
  const exactFile = prepareDeliveryRequest({ ...base, allowedPaths: ["docs/guide.md"] });
  assert.deepEqual(exactFile.allowedPaths, ["docs/guide.md"], "精确文件条目语义不变");

  // matcher 语义钉死（SSOT 未动）：段边界前缀，sibling 前缀不误吞。
  assert.equal(isPathAllowed("src/a.js", ["src"]), true, "allow-inside-dir");
  assert.equal(isPathAllowed("src/deep/b.js", ["src"]), true, "多级段仍在界内");
  assert.equal(isPathAllowed("src2/a.js", ["src"]), false, "sibling-prefix 非匹配");
  assert.equal(isPathAllowed("docs/guide.md", ["src"]), false, "界外文件非匹配");
  assert.equal(isPathAllowed("src", ["src"]), true, "目录自身命中");

  // 其余非法形状照旧拒绝，错误消息回显调用方原始输入（不是归一化后的值）。
  for (const bad of ["src//", "/", "./", "../escape", "C:/abs"]) {
    // 校验是同步 throw——必须用 assert.throws（rejects 不接同步抛出，
    // TD-137 批次 Lead 收尾修正：worker 原用 rejects 导致异常穿透）。
    assert.throws(
      () => prepareDeliveryRequest({ ...base, allowedPaths: [bad] }),
      (e) => {
        assert.match(e.message, /invalid allowedPath/, `非法条目 ${JSON.stringify(bad)} 必须拒绝`);
        assert.ok(e.message.includes(JSON.stringify(bad)), "错误回显原始输入");
        return true;
      },
    );
  }
});

test("TD-137④ candidateInventory 投影：目录契约下的界内/越界分类；读侧严格校验器仍拒绝尾斜杠", async () => {
  const { computeCandidateInventory } = await import("../../src/application/candidateInventory.js");
  const wt = "D:/tmp/fake-wt";
  const baseCommit = "0123456789abcdef0123456789abcdef01234567";
  const listFn = () => ["src/a.js", "src/deep/b.js", "src2/c.js", "README.md"];

  const inv = computeCandidateInventory(wt, baseCommit, ["src"], listFn);
  assert.ok(inv, "目录契约合法，inventory 非 null");
  assert.deepEqual(inv.originalAllowedPaths, ["src"]);
  assert.deepEqual(inv.actualChangedPaths, ["README.md", "src/a.js", "src/deep/b.js", "src2/c.js"]);
  assert.deepEqual(inv.disallowedPaths, ["README.md", "src2/c.js"],
    "sibling 前缀与界外文件如实列为越界候选（isPathAllowed SSOT 未动）");
  assert.equal(inv.disallowedCount, 2);

  // 读侧投影校验器保持严格：持久化契约永远归一化，尾斜杠形状到不了这里；
  // 万一出现（脏数据）则 fail-closed 为 null，绝不部分真相。
  assert.equal(computeCandidateInventory(wt, baseCommit, ["src/"], listFn), null,
    "尾斜杠契约在读侧仍非法（写路径已归一化，此为防御性钉子）");
});

test("TD-137③ runId UTC 说明双通道在场：使用手册派发页正文 + HELP_TEXT（再生 cli.md 同步）", async () => {
  const sentence = "runId 内嵌时间戳为 UTC；本地时间需自行换算";
  const usage = readFileSync(resolve(import.meta.dirname, "../../docs/usage/dispatch.md"), "utf8");
  assert.ok(usage.includes(sentence), "docs/usage/dispatch.md 在 runId 首现附近补 UTC 说明");
  const cliMd = readFileSync(resolve(import.meta.dirname, "../../docs/surface/cli.md"), "utf8");
  assert.ok(cliMd.includes(sentence), "cli.md 由 gen:surface 从 HELP_TEXT 再生，同步携带");
});

// ===== TD-153 CLI 工效批（Run A）：(c) --active 透传 / (b) --final×json 警告 / (d2) grep-prune 时间戳稳定排序 =====
//
// 状态枚举（WQ-02）：
//   (b) collect --final × --format json 的四类态：available/empty/too_large 三态共享同一条
//       stderr 警告代码路径（警告在四态分支之前、投影成功之后），本批测 available 代表
//       态 + 裸 --final 无警告回归 + 错误态（run 不存在：抛错、无 stdout、警告不抢在错误前）。
//   (c) runs list --active 的三态夹具：terminal / 无心跳非终态（unresolved）/ 新鲜心跳非终态
//       （active）——证明 --active 是"证明活跃"过滤而非"非终态"过滤；另测 --active false
//       不静默收窄（parseOptions 值形状变字符串）。
//   (d2) 纯函数全态：同毫秒并列、wf/run 时间交错、无时间戳殿后、纯 run_* 标准语料与旧
//       字典序同序（回归不变式）；grep 集成一层验证 loadRunFiles wiring。

/** TD-153(b)：同时捕获 console.log（stdout）与 console.error（stderr）。 */
async function captureLogAndErr(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => { out.push(a.map(String).join(" ")); };
  console.error = (...a) => { err.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

test("TD-153(b) collect --final × --format json：stdout 四态文本逐字节不变，stderr 恰一行警告指路分页投影", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td153-final-"));
  try {
    await drainStrayCliMain();
    // available 态夹具（对齐 collectFinal.test.js 已绿形状：进程分支 + 最后一条 assistant）。
    const runId = "run_td153final";
    const line = (p) => JSON.stringify(p);
    writeFileSync(join(dir, `${runId}.jsonl`), [
      line({ type: "run.submitted", agentId: "researcher", ts: "2026-08-23T00:00:00.000Z" }),
      line({ type: "session.created", backend: "process", backendSessionId: "proc_td153", runId, agentId: "researcher" }),
      line({ type: "run.started", backend: "claude-code", ts: "2026-08-23T00:00:01.000Z", runId, agentId: "researcher" }),
      line({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "最终答复文本" }], ts: "2026-08-23T00:00:05.000Z", runId, agentId: "researcher" }),
      line({ type: "run.completed", ts: "2026-08-23T00:00:06.000Z", runId, agentId: "researcher" }),
    ].join("\n") + "\n", "utf8");

    // 组合态：警告在 stderr 恰一行；stdout 仍是四态文本（不是投影 JSON 信封）。
    const combo = await captureLogAndErr(() =>
      collectCommand([runId, "--run-dir", dir, "--final", "--format", "json"], { runDir: dir }));
    assert.equal(combo.out, "最终答复文本", "stdout 与裸 --final 逐字节一致（警告只走 stderr）");
    const errLines = combo.err.split("\n").filter((l) => l.length > 0);
    assert.equal(errLines.length, 1, `stderr 恰一行（got: ${JSON.stringify(errLines)}）`);
    assert.match(errLines[0], /--final .* --format json envelope/, "警告点名 --final 不输出 json 信封");
    assert.match(errLines[0], /nextCursor/, "警告给出分页 collect 指引（机器可读出口）");

    // 回归：裸 --final（不带 --format json）零 stderr、stdout 同文本。
    const bare = await captureLogAndErr(() =>
      collectCommand([runId, "--run-dir", dir, "--final"], { runDir: dir }));
    assert.equal(bare.err, "", "裸 --final 不触发警告（只在组合时警告）");
    assert.equal(bare.out, "最终答复文本", "裸 --final stdout 不变");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-153(b) 错误态：--final × --format json 且 run 不存在 → 照旧抛错、无 stdout、警告不抢在错误前", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td153-finalerr-"));
  try {
    await drainStrayCliMain();
    let threw = null;
    const cap = await captureLogAndErr(() =>
      collectCommand(["run_td153_missing", "--run-dir", dir, "--final", "--format", "json"], { runDir: dir })
        .catch((e) => { threw = e; }));
    assert.ok(threw, "run 不存在 → 投影读取失败照旧抛错（警告分支不吞错、不遮错误）");
    assert.equal(cap.out, "", "错误态无 stdout");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-153(c) runs list --active：仅透传服务层 activeOnly（心跳新鲜的活跃 run 才入选；terminal/unresolved 排除）", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-td153-active-"));
  try {
    await drainStrayCliMain();
    // 三态夹具（复用 writeTd137RunTranscript：终态/非终态最小信封 transcript）。
    writeTd137RunTranscript(dir, "run_td153done", true);
    writeTd137RunTranscript(dir, "run_td153unres", false);
    writeTd137RunTranscript(dir, "run_td153act", false);
    // 唯一"证明活跃"的 run：新鲜 owner 心跳租约（checkOwnerLiveness SSOT）。
    writeFileSync(join(dir, ".owner-run_td153act"),
      JSON.stringify({ pid: 4242, heartbeatAt: Date.now() }), "utf8");

    const all = JSON.parse(await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--format", "json"], {})));
    assert.equal(all.matchedCount, 3, "不带 --active：terminal/unresolved/active 三态都列出");

    const act = JSON.parse(await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--active", "--format", "json"], {})));
    assert.deepEqual(act.runs.map((r) => r.runId), ["run_td153act"],
      "--active 只留心跳新鲜的活跃 run——terminal 与无心跳非终态（unresolved）都排除，不是'非终态'过滤");

    // parseOptions 值形状：`--active false` → 字符串 "false"。静默收窄输出比静默忽略更
    // 危险，故仅显式 true/"true" 生效——false 不启用过滤器。
    const noNarrow = JSON.parse(await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--active", "false", "--format", "json"], {})));
    assert.equal(noNarrow.matchedCount, 3, "--active false 不静默收窄输出");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-153(d2) sortRunFileNames 纯函数：时间戳升序、wf/run 时间交错、无时间戳殿后、同毫秒字典序决胜", async () => {
  const { sortRunFileNames } = await import("../../src/commands/runs.js");

  // 回归不变式：纯 run_* 标准语料（等宽 17 位时间戳）与旧字典序 .sort() 同序。
  const runOnly = [
    "run_20260917201628180gh6kx8.jsonl",
    "run_20260102030400000aaaaaa.jsonl",
    "run_20260102030400000bbbbbb.jsonl",
    "run_20260917201628180abc999.jsonl",
  ];
  assert.deepEqual(sortRunFileNames(runOnly), [...runOnly].sort(),
    "纯 run_* 标准语料：与旧字典序同序（旧序即创建序，零行为变化）");

  // 混合语料：wf 与 run 按时间交错（旧序按形状前缀分组：run_* 全在前、wf_ 全在
  // 后）；自定义 id（run_1dev，字典序 '1'<'2' 本排最前）殿后。
  assert.deepEqual(sortRunFileNames([
    "run_1dev.jsonl",
    "run_20260917201628180gh6kx8.jsonl",
    "wf_20260101000000000.jsonl",
    "run_20260102030400000bbbbbb.jsonl",
  ]), [
    "wf_20260101000000000.jsonl",
    "run_20260102030400000bbbbbb.jsonl",
    "run_20260917201628180gh6kx8.jsonl",
    "run_1dev.jsonl",
  ], "时间戳升序交错 + 无时间戳前缀殿后（旧字典序会把 run_1dev 排最前、wf 排最后）");

  // auditor F2 回归钉：相邻毫秒（...180 vs ...181）在旧 Number 化下丢精度碰撞、
  // 落回字典序把较晚的 run_181 排在较旱的 wf_180 前。字符串比较修复后必须时间序。
  assert.deepEqual(sortRunFileNames([
    "run_20260917201628181aaaaaa.jsonl",
    "wf_20260917201628180.jsonl",
  ]), [
    "wf_20260917201628180.jsonl",
    "run_20260917201628181aaaaaa.jsonl",
  ], "相邻毫秒不因 Number 精度丢失而错序（17 位 > MAX_SAFE_INTEGER）");
});

test("TD-153(d2) runs grep 输出序：经 loadRunFiles 时间戳排序（自定义 id 殿后，不再字典序混排）", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-td153-grep-"));
  try {
    await drainStrayCliMain();
    const writeNeedle = (runId, ts) => writeFileSync(join(dir, `${runId}.jsonl`),
      JSON.stringify({ seq: 1, ts, type: "run.started", runId, agentId: "coder_low", backend: "claude-code", prompt: "needle" }) + "\n", "utf8");
    // 字典序旧序：run_1dev < run_2026*（'1'<'2'）→ 自定义 id 排最前；新序殿后。
    writeNeedle("run_1dev", "2026-01-01T00:00:00.000Z");
    writeNeedle("run_20260102030400000aaaaaa", "2026-01-02T00:00:00.000Z");
    writeNeedle("run_20260917201628180gh6kx8", "2026-09-17T00:00:00.000Z");

    const parsed = JSON.parse(await captureLog(() =>
      runsCommand(["grep", "needle", "--run-dir", dir, "--format", "json"], {})));
    assert.equal(parsed.matched, 3);
    assert.deepEqual(parsed.matches.map((m) => m.runId), [
      "run_20260102030400000aaaaaa",
      "run_20260917201628180gh6kx8",
      "run_1dev",
    ], "grep 行序 = 时间戳升序 + 无时间戳 id 殿后（loadRunFiles 已接 sortRunFileNames）");
  } finally {
    rmrfRetry(dir);
  }
});

// ===== TD-153 残余实施批：runs list --state / --since =====
//
// 状态枚举（WQ-02）：
//   - 参数校验态：非法 state 值（闭集报错）、裸 --state/--since（缺值）、
//     --since 非法 duration、--active × --state 一切组合（含 running）
//   - 过滤正常态：闭集投影命中、时间窗新鲜/超龄、组合叠加、JSON 结构化零结果
//   - 判别态：--state running 保留 unresolved（无心跳非终态）——与 --active 的
//     "证明活跃"语义相反
//   - 形状稳定态：过滤序不影响 JSON 键集与行字段（与无过滤对照）
//   不适用：loading/异步态（runsCommand 单次执行，无 UI 状态机）；
//   unparseable transcript × 过滤 = service 层既有 skip-silently 路径
//   （runs.test.js TD-153 系列已钉，CLI 层不重复）。

/** TD-153 残余批夹具：带信封、终态 run.state_change 定 state、末条 ts 定 updatedAt。 */
function writeTd153ListStateRun(runDir, runId, agentId, state, lastTs) {
  const events = [
    { seq: 1, ts: new Date(Date.parse(lastTs) - 60_000).toISOString(), type: "run.started", runId, agentId, backend: "claude-code" },
    { seq: 2, ts: lastTs, type: "run.state_change", runId, agentId, from: "running", to: state, reason: "td153" },
  ];
  writeFileSync(join(runDir, `${runId}.jsonl`),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

test("TD-153 runs list --state：闭集校验报错列全闭集；--active × --state 一切组合 fail-closed 拒绝（含 running）", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const { RUN_STATES } = await import("../../src/transcript.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-td153-state-"));
  try {
    await drainStrayCliMain();
    // 非法值：报错文案列出闭集全部成员（与 RUN_STATES SSOT 零漂移）+ 示例
    await assert.rejects(
      runsCommand(["list", "--run-dir", dir, "--state", "succeeded", "--format", "json"], {}),
      (err) => {
        assert.ok(err.message.includes("--state"), "报错点名 --state");
        for (const s of RUN_STATES) {
          assert.ok(err.message.includes(s), `闭集成员 ${s} 必须在报错文案中`);
        }
        assert.ok(err.message.includes("(e.g. --state failed)"), "给出示例");
        return true;
      },
    );
    // --active × --state：running（子集形状）与 completed（矛盾形状）都拒绝
    for (const v of ["running", "completed"]) {
      await assert.rejects(
        runsCommand(["list", "--run-dir", dir, "--active", "--state", v, "--format", "json"], {}),
        /--state cannot be combined with --active/,
        `--active × --state ${v} 必须拒绝`,
      );
    }
    // 值形状（--active false 不启用）× --state 合法共存：false 不触发冲突拒绝
    await assert.rejects(
      runsCommand(["list", "--run-dir", dir, "--active", "false", "--state", "bogus", "--format", "json"], {}),
      /--state must be one of/,
      "--active false 未启用过滤器：报的是闭集校验（不是冲突）",
    );
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-153 runs list --since/--state 参数形状：duration 语法与 prune 同一解析器；裸 flag 缺值拒绝", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-td153-shape-"));
  try {
    await drainStrayCliMain();
    // duration 语法与 prune --older-than 同源（同一 parseDuration、同一报错）
    await assert.rejects(
      runsCommand(["list", "--run-dir", dir, "--since", "abc", "--format", "json"], {}),
      /Invalid duration/,
    );
    await assert.rejects(
      runsCommand(["list", "--run-dir", dir, "--since", "7x", "--format", "json"], {}),
      /Invalid duration/,
    );
    // 裸 flag（parseOptions → true）与值位被下一 flag 占据的形状：缺值拒绝
    await assert.rejects(
      runsCommand(["list", "--run-dir", dir, "--state"], {}),
      /--state requires a value/,
    );
    await assert.rejects(
      runsCommand(["list", "--run-dir", dir, "--state", "--format", "json"], {}),
      /--state requires a value/,
    );
    await assert.rejects(
      runsCommand(["list", "--run-dir", dir, "--since"], {}),
      /--since requires a duration value/,
    );
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-153 runs list --state/--since 过滤与组合正交：行集叠加、JSON 形状稳定；--state running 保留 unresolved（非 --active 语义）", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-td153-filter-"));
  try {
    await drainStrayCliMain();
    // 夹具相对真实 now（与 prune 测试同款鲁棒性：测试任何日期运行都成立）
    const now = Date.now();
    const at = (msAgo) => new Date(now - msAgo).toISOString();
    // 交叉语料：agent × state × 时间窗
    writeTd153ListStateRun(dir, "run_done_recent", "coder_low", "completed", at(30 * 60_000));
    writeTd153ListStateRun(dir, "run_fail_old", "coder_low", "failed", at(10 * 24 * 3_600_000));
    writeTd153ListStateRun(dir, "run_fail_recent", "researcher", "failed", at(2 * 3_600_000));
    // 非终态无心跳（unresolved）：--state running 应保留（--active 排除——(c) 测试已钉）
    writeTd137RunTranscript(dir, "run_live_unres", false);

    const base = JSON.parse(await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--format", "json"], {})));
    assert.equal(base.matchedCount, 4, "无过滤：四类 run 全列");

    // --state failed：failed 两行（updatedAt desc：recent 在前）
    const failed = JSON.parse(await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--state", "failed", "--format", "json"], {})));
    assert.deepEqual(failed.runs.map((r) => r.runId), ["run_fail_recent", "run_fail_old"],
      "--state failed 只留 failed，最新在前");

    // × --since 7d：old failed 出窗
    const f7 = JSON.parse(await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--state", "failed", "--since", "7d", "--format", "json"], {})));
    assert.deepEqual(f7.runs.map((r) => r.runId), ["run_fail_recent"], "--state × --since 叠加");
    assert.equal(f7.matchedCount, 1);

    // 再叠 --agent coder_low：窗内 failed 是 researcher → 结构化零结果
    const none = JSON.parse(await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--state", "failed", "--since", "7d", "--agent", "coder_low", "--format", "json"], {})));
    assert.equal(none.matchedCount, 0, "--agent 叠加后零命中仍是结构化 JSON（非文本 No runs found）");

    // --state running：保留无心跳非终态（unresolved 行仍列出）——与 --active 判别
    const running = JSON.parse(await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--state", "running", "--format", "json"], {})));
    assert.deepEqual(running.runs.map((r) => r.runId), ["run_live_unres"]);
    assert.equal(running.runs[0].activityStatus, "unresolved", "--state running 不是证明活跃过滤");

    // --latest N 在过滤后截取（matchedCount = 过滤后、截取前）
    const l1 = JSON.parse(await captureLog(() =>
      runsCommand(["list", "--run-dir", dir, "--state", "failed", "--latest", "1", "--format", "json"], {})));
    assert.deepEqual(l1.runs.map((r) => r.runId), ["run_fail_recent"]);
    assert.equal(l1.matchedCount, 2, "matchedCount 计过滤后截取前");

    // JSON 形状稳定：键集与行字段序与无过滤一致（过滤序不影响输出形状）
    assert.deepEqual(Object.keys(f7), Object.keys(base));
    assert.deepEqual(Object.keys(f7.runs[0]), Object.keys(base.runs[0]));
  } finally {
    rmrfRetry(dir);
  }
});

//
// 后台派发（run --background、不带 --wait 的单 agent spawn）与前台一样遵守
// --isolate/--no-isolate/--tag。全链钉法（R10-A-CLI-8 先例）：真实 CLI 子进程 + 不存在 binary（runner 快速
// failed，零 provider），从 run.started 读 RunManager.start 实收的隔离/标签事实。

// 等 runner 把 run 推到终态后返回事件列表（复用 TD-54/WF-6 轮询形状）。到终态即
// 返回；30s 上限只在全量并发、建 worktree 偏慢时用得到。等终态而不是只等
// run.started：清理临时目录时 runner 已经停下。
async function awaitTerminalEvents(transcriptPath) {
  const terminal = ["failed", "completed", "timed_out", "aborted"];
  let events = [];
  for (let i = 0; i < 300; i += 1) {
    if (existsSync(transcriptPath)) {
      events = await readTranscript(transcriptPath);
      if (terminal.includes(findState(events))) return events;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`runner 30s 内没有把 run 推到终态（当前状态 ${findState(events) ?? "无转录"}）`);
}

// git 仓夹具（worktree 隔离需要真仓）。
function makeGitRepo(dir) {
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# t\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
}

test("CLI 全链: run --background --isolate 的非交付运行真隔离（run.started 带 worktreePath）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cli-iso-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { bg_iso: { backend: "claude-code", binary: "nonexistent-binary-iso", cwd: dir } },
    }), "utf8");
    const runDir = join(dir, "runs");

    const result = spawnSync(process.execPath, [
      "src/cli.js", "run", "bg_iso",
      "--prompt", "x",
      "--background",
      "--isolate",
      "--registry", registryPath,
      "--run-dir", runDir,
      "--wait-timeout", "2000",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
    assert.equal(result.status, 0, `background dispatch 应立即返回: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"), result.stdout.lastIndexOf("}") + 1));
    assert.equal(parsed.background, true);

    const events = await awaitTerminalEvents(resolveTranscriptPath(runDir, parsed.runId));
    assert.ok(events.length > 0, "runner 必须写 transcript");
    const started = events.find((e) => e.type === "run.started");
    assert.ok(started?.worktreePath, "--isolate 的非交付后台运行在 worktree 里跑（isolate:true 传到了 RunManager.start）");
  } finally {
    rmrfRetry(dir);
  }
});

test("CLI 全链: 不带 --wait 的单 agent spawn --isolate 同样在 worktree 里跑", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cli-spawn-iso-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { sp_iso: { backend: "claude-code", binary: "nonexistent-binary-spawn-iso", cwd: dir } },
    }), "utf8");
    const runDir = join(dir, "runs");

    const result = spawnSync(process.execPath, [
      "src/cli.js", "spawn", "sp_iso",
      "--prompt", "x",
      "--isolate",
      "--registry", registryPath,
      "--run-dir", runDir,
      "--wait-timeout", "2000",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
    assert.equal(result.status, 0, `不带 --wait 的 spawn 应立即返回: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"), result.stdout.lastIndexOf("}") + 1));
    assert.equal(parsed.background, true);

    const events = await awaitTerminalEvents(resolveTranscriptPath(runDir, parsed.runId));
    const started = events.find((e) => e.type === "run.started");
    assert.ok(started?.worktreePath, "不带 --wait 的 spawn 走后台路径，--isolate 同样生效");
  } finally {
    rmrfRetry(dir);
  }
});

test("CLI 全链: run --background --no-isolate 压制 agent 隔离配置；不给旗标则配置生效", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cli-noiso-"));
  try {
    makeGitRepo(dir);
    // agent 默认 worktree 隔离——--no-isolate 是否真传到 start 由 cwd 形状判别。
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { bg_noiso: { backend: "claude-code", binary: "nonexistent-binary-noiso", cwd: dir, isolation: "worktree" } },
    }), "utf8");
    const runDir = join(dir, "runs");

    const runBg = (extra) => {
      const res = spawnSync(process.execPath, [
        "src/cli.js", "run", "bg_noiso",
        "--prompt", "x",
        "--background",
        ...extra,
        "--registry", registryPath,
        "--run-dir", runDir,
        "--wait-timeout", "2000",
      ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
      assert.equal(res.status, 0, `background dispatch 应立即返回: ${res.stderr}`);
      return JSON.parse(res.stdout.slice(res.stdout.indexOf("{"), res.stdout.lastIndexOf("}") + 1));
    };

    const noIso = runBg(["--no-isolate"]);
    const eventsNo = await awaitTerminalEvents(resolveTranscriptPath(runDir, noIso.runId));
    const startedNo = eventsNo.find((e) => e.type === "run.started");
    assert.equal(startedNo?.worktreePath, undefined, "--no-isolate: 不建 worktree（false 传到 start 并压制 agent 隔离配置）");
    assert.equal(startedNo?.cwd, dir, "--no-isolate: worker cwd 是源仓本身");

    const noFlag = runBg([]);
    const eventsCfg = await awaitTerminalEvents(resolveTranscriptPath(runDir, noFlag.runId));
    const startedCfg = eventsCfg.find((e) => e.type === "run.started");
    assert.ok(startedCfg?.worktreePath, "不给旗标: agent 隔离配置照常生效（缺席≠false）");
  } finally {
    rmrfRetry(dir);
  }
});

test("CLI 全链: 两个 --tag 都进后台 run.started.tags，形状与前台一致", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cli-tags-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { bg_tag: { backend: "claude-code", binary: "nonexistent-binary-tag", cwd: dir } },
    }), "utf8");
    const runDir = join(dir, "runs");

    // 后台：真实 CLI 子进程全链（argv → runner 解析 → RunManager.start）。
    const result = spawnSync(process.execPath, [
      "src/cli.js", "run", "bg_tag",
      "--prompt", "x",
      "--background",
      "--tag", "team=alpha",
      "--tag", "work=fix",
      "--registry", registryPath,
      "--run-dir", runDir,
      "--wait-timeout", "2000",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
    assert.equal(result.status, 0, `background dispatch 应立即返回: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"), result.stdout.lastIndexOf("}") + 1));

    const events = await awaitTerminalEvents(resolveTranscriptPath(runDir, parsed.runId));
    const started = events.find((e) => e.type === "run.started");
    assert.deepEqual(started?.tags, { team: "alpha", work: "fix" }, "两条 --tag 全部到达后台 run.started");

    // 前台：同 flags 直跑（注入 backend，不 fork），钉"形状与前台一致"。
    const fakeBackend = {
      async spawn() {
        return {
          backend: "claude-code",
          backendSessionId: "s_fg_tag",
          messageId: "m_fg_tag",
          admittedSeq: 1,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const cfg = {
      registry: registryPath,
      runDir,
      readRegistry: async () => readRegistryFile(registryPath),
      backendFor: () => fakeBackend,
      loadLanesConfigFn: () => ({ lanes: [], sha256: null, issues: [], rolesHint: [] }),
    };
    const origLog = console.log;
    console.log = () => {};
    try {
      await runCommand(["bg_tag", "--prompt", "fg", "--tag", "team=alpha", "--tag", "work=fix"], cfg);
    } finally {
      console.log = origLog;
    }
    // 前台 runId 从最近转录取：找本 agent 最新含两条 tag 的 run.started。
    const transcripts = listTranscriptsDeep(runDir).map((e) => e.path);
    let fgStarted = null;
    for (const t of transcripts) {
      const evts = await readTranscript(t);
      const s = evts.find((e) => e.type === "run.started");
      if (s && !s.worktreePath && evts.some((e) => e.type === "prompt.sent" && e.prompt === "fg")) {
        fgStarted = s;
        break;
      }
    }
    assert.deepEqual(fgStarted?.tags, { team: "alpha", work: "fix" }, "前台同 flags 产出同形状 tags（后台与前台的 start 形状一致）");
  } finally {
    rmrfRetry(dir);
  }
});

// ── TD-341（第 89 批 C3）：status 在 runner 被证明不在时附 stderr 尾部 ──────
// 服务经 deps.getRunStatusFn 注入桩（真实形状：runnerGone:true + 双语新模板）；
// 尾部文件用真实 .runner-<runId>.stderr——展示处理（脱敏/清洗/限长）走真模块。

test("TD-341-C3: status runnerGone → JSON 带 runnerGone+runnerStderrTail；line 行尾附同一尾部", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td341c3-status-"));
  try {
    const runId = "run_td341_status";
    writeFileSync(join(dir, `${runId}.jsonl`), "", "utf8");
    writeFileSync(join(dir, `.runner-${runId}.stderr`),
      "FATAL: heap OOM\nAuthorization: Bearer abcdef1234567890abcdef1234567890\r\n", "utf8");
    const fakeStatus = async () => ({
      runId,
      agentId: "coder_hq",
      state: "running",
      terminal: false,
      executionStage: { phase: "active", sinceTs: "2026-11-08T10:00:00.000Z", secondsSince: 1200 },
      last: null,
      lastActivityTs: null,
      secondsSinceActivity: null,
      lastActivityKind: null,
      lastActivitySummary: null,
      lastEventType: null,
      lastEventTs: null,
      lastActivityEventKind: null,
      observedSeq: 3,
      secondsSinceEffect: 1200,
      leadAdvisory: "观察时没有 WAO 进程能继续驱动这个运行（owner 心跳已不在、本机无 runner 进程、转录静默已满 20 分钟），继续等待不会自行收口。是否结算由 Lead 决定：先干跑 wao runs settle --run-id run_td341_status --reason-file <文件>，确认后再加 --apply。",
      leadAdvisoryWire: "wire",
      runnerGone: true,
    });
    const jsonElements = await captureElements(async () => {
      await statusCommand([runId, "--run-dir", dir], { runDir: dir }, { getRunStatusFn: fakeStatus });
    });
    const parsed = cliJsonBlock(jsonElements);
    assert.equal(parsed.runnerGone, true);
    assert.ok(parsed.runnerStderrTail.includes("FATAL: heap OOM"), "JSON 面带展示处理后的尾部");
    assert.ok(!parsed.runnerStderrTail.includes("abcdef1234567890"), "JSON 面尾部脱敏");
    assert.ok(parsed.runnerStderrTail.includes("Bearer [REDACTED]"));
    assert.ok(parsed.advisory.startsWith("观察时没有 WAO 进程能继续驱动这个运行"), "CLI 面中文新模板");

    const lineElements = await captureElements(async () => {
      await statusCommand([runId, "--run-dir", dir, "--format", "line"], { runDir: dir }, { getRunStatusFn: fakeStatus });
    });
    assert.equal(lineElements.length, 1);
    const line = lineElements[0];
    assert.ok(line.includes("runnerStderrTail="), "line 行尾附 runnerStderrTail");
    assert.ok(!line.includes("abcdef1234567890"), "line 面同样脱敏");
    const m = line.match(/ runnerStderrTail=(".*")$/);
    assert.ok(m, "runnerStderrTail 是行尾 JSON 字符串字段");
    assert.ok(JSON.parse(m[1]).includes("FATAL: heap OOM"));
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-341-C3: runnerGone 但无 stderr 文件 → runnerStderrTail 写明\"无 runner stderr 记录\"", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td341c3-none-"));
  try {
    const runId = "run_td341_none";
    writeFileSync(join(dir, `${runId}.jsonl`), "", "utf8");
    const fakeStatus = async () => ({
      runId, agentId: "coder_hq", state: "running", terminal: false,
      executionStage: { phase: "active", sinceTs: null, secondsSince: null },
      last: null, lastActivityTs: null, secondsSinceActivity: null,
      lastActivityKind: null, lastActivitySummary: null,
      lastEventType: null, lastEventTs: null, lastActivityEventKind: null,
      observedSeq: 0,
      leadAdvisory: "观察时没有 WAO 进程能继续驱动这个运行……",
      leadAdvisoryWire: "wire",
      runnerGone: true,
    });
    const elements = await captureElements(async () => {
      await statusCommand([runId, "--run-dir", dir], { runDir: dir }, { getRunStatusFn: fakeStatus });
    });
    const parsed = cliJsonBlock(elements);
    assert.equal(parsed.runnerStderrTail, "无 runner stderr 记录");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-341-C3: 未证明 runnerGone 的普通 run → 输出形状逐字节不变（无新字段）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td341c3-plain-"));
  try {
    const runId = "run_td341_plain";
    writeFileSync(join(dir, `${runId}.jsonl`),
      JSON.stringify({ type: "run.submitted", agentId: "coder_hq", ts: "2026-11-08T00:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "completed", ts: "2026-11-08T00:01:00.000Z" }) + "\n");
    const elements = await captureElements(async () => {
      await statusCommand([runId, "--run-dir", dir], { runDir: dir }, {
        getRunStatusFn: async (input) => getRunStatus({ ...input, runnerGoneDeps: undefined }),
      });
    });
    const parsed = cliJsonBlock(elements);
    assert.equal("runnerGone" in parsed, false);
    assert.equal("runnerStderrTail" in parsed, false);
  } finally {
    rmrfRetry(dir);
  }
});
