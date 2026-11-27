// test/run-lifecycle/dispatchLabelLaneRules.test.js
//
// 第 156 批（TD-384）CLI `wao run` 的出口钉：
//   - stderr：Owner 规则块（每条一行，[wao] 前缀，与 laneFacts 同一时点、规则块
//     在车道行之前）；构造降级 → 恰一行"不可用"；fail-degrade 不阻塞派发；
//   - --background 的 JSON：label（[车道] 任务名/退回 runId）+ laneRules + note
//     末尾的命名短提示（后台任务可命名 <label>）；
//   - 前台文本：label: 一行；前台 --format json：laneRules 在结果里（label 不进
//     前台 JSON——归 --background 与 MCP 回执）。
// 夹具纪律：laneRulesFn/laneFactsLineFn/loadLanesConfigFn 全注入——不读真实画像
// 与车道表；注册表与 backend 全注入，零真实派发。
process.env.WAO_ALLOW_NESTED_DISPATCH = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { readRegistry } from "../../src/registry.js";
import { runCommand } from "../../src/commands/run.js";

const LANES = {
  ok: true, path: "fixture", sha256: "ab".repeat(32), issues: [], rolesHint: [],
  lanes: [{ id: "fixture-lane", backend: "claude-code", model: { id: "fixture-m" }, reasoning: null, aliases: {} }],
};

const FAKE_RULES = {
  rules: ["夹具规则甲：非高峰优先低价车道", "夹具规则乙：越级要写理由"],
  now: { beijing: "周四 15:00", holidaysRecognized: false, peaks: [] },
};
const DEGRADED_RULES = { rules: null, rulesReason: "ownerRules 缺失、不合法、为空或读取失败", now: null };

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md && git commit -m i", { cwd: dir, stdio: "pipe" });
}

function writeRegistry(dir, ids) {
  const registryPath = join(dir, "agents.json");
  const agents = {};
  for (const id of ids) agents[id] = { backend: "claude-code", cwd: dir };
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function fakeBackendFactory(capture) {
  return {
    supportsRoleContract: true, sessionOutlivesProcess: false,
    async spawn(agent) {
      capture.spawned += 1;
      return {
        backend: "zcode", backendSessionId: "s1", messageId: "m1", admittedSeq: 5,
        async *events() { yield { kind: "done", reason: "completed" }; },
        abort: async () => {},
      };
    },
    defaultBinary() { return "node"; }, credentialEnvNames: () => [],
  };
}

async function withCapturedConsole(fn) {
  const stderr = [];
  const stdout = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => { stderr.push(a.join(" ")); };
  console.log = (...a) => { stdout.push(a.join(" ")); };
  try {
    await fn();
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
  return { stderr, stdout };
}

function baseConfig(dir, registryPath, over = {}) {
  return {
    registry: registryPath,
    runDir: join(dir, "runs"),
    readRegistry: async () => readRegistry(registryPath),
    loadLanesConfigFn: () => LANES,
    laneRulesFn: () => FAKE_RULES,
    laneFactsLineFn: () => null,
    ...over,
  };
}

test("156 CLI stderr：规则块每条一行带 [wao] 前缀、在车道事实行之前；派发照常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-156-cli-err-"));
  try {
    makeGitRepo(dir);
    const registryPath = writeRegistry(dir, ["fixture-lane"]);
    const capture = { spawned: 0 };
    const cfg = baseConfig(dir, registryPath, {
      backendFor: () => fakeBackendFactory(capture),
      laneFactsLineFn: () => "所选车道事实（只陈列，不是推荐）：fixture-lane · 夹具",
    });
    const { stderr } = await withCapturedConsole(async () => {
      await runCommand(["fixture-lane", "--prompt", "# 夹具任务\n正文"], cfg);
    });
    const rulesLines = stderr.filter((l) => l.startsWith("[wao] 以下为 Owner 原文") || /^\[wao\] \d+\. 夹具规则/.test(l));
    assert.ok(rulesLines.length >= 3, "标头 + 两条规则行");
    assert.equal(stderr[stderr.findIndex((l) => l.includes("以下为 Owner 原文")) + 1], "[wao] 1. 夹具规则甲：非高峰优先低价车道");
    assert.ok(stderr.some((l) => l.includes("此刻（北京时间 周四 15:00；法定节假日不识别）")), "此刻行带节假日口径");
    const factsIdx = stderr.findIndex((l) => l.includes("所选车道事实"));
    const rulesIdx = stderr.findIndex((l) => l.includes("以下为 Owner 原文"));
    assert.ok(rulesIdx >= 0 && factsIdx > rulesIdx, "规则块在车道事实行之前");
    assert.equal(capture.spawned, 1, "派发照常完成（fail-degrade 不拦截）");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("156 CLI stderr：构造降级 → 恰一行不可用行；仍不阻塞派发", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-156-cli-deg-"));
  try {
    makeGitRepo(dir);
    const registryPath = writeRegistry(dir, ["fixture-lane"]);
    const capture = { spawned: 0 };
    const cfg = baseConfig(dir, registryPath, {
      backendFor: () => fakeBackendFactory(capture),
      laneRulesFn: () => DEGRADED_RULES,
    });
    const { stderr } = await withCapturedConsole(async () => {
      await runCommand(["fixture-lane", "--prompt", "t"], cfg);
    });
    const degradedLines = stderr.filter((l) => l.includes("车道规则不可用"));
    assert.equal(degradedLines.length, 1, "恰一行不可用行");
    assert.ok(degradedLines[0].startsWith("[wao] "), "[wao] 前缀");
    assert.equal(capture.spawned, 1, "派发照常完成");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("156 CLI --background JSON：label + laneRules 进结果；note 末尾带命名短提示", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-156-cli-bg-"));
  try {
    makeGitRepo(dir);
    const registryPath = writeRegistry(dir, ["fixture-lane"]);
    const dispatchCalls = [];
    const cfg = baseConfig(dir, registryPath, {
      dispatchRunFn: async (input) => {
        dispatchCalls.push(input);
        return { accepted: true, runId: "run_156_bg", agentId: "fixture-lane", transcriptPath: "/x.jsonl" };
      },
    });
    const { stdout, stderr } = await withCapturedConsole(async () => {
      await runCommand(["fixture-lane", "--background", "--prompt", "# 夹具任务\n正文"], cfg);
    });
    assert.equal(dispatchCalls.length, 1, "后台派发恰好一次");
    const parsed = JSON.parse(stdout.join("\n"));
    assert.equal(parsed.background, true);
    assert.equal(parsed.label, "[fixture-lane] 夹具任务", "label=[车道] 任务名（标题去 # 记号）");
    assert.deepEqual(parsed.laneRules, FAKE_RULES, "laneRules 进 JSON（与 stderr 同一构造产物）");
    assert.ok(parsed.note.includes("wao runs wait <runId> --until-settled"), "note 仍带等待半句");
    assert.ok(parsed.note.endsWith(" （后台任务可命名 [fixture-lane] 夹具任务）"), `note 末尾命名短提示: ${parsed.note}`);
    assert.ok(!/codex|claude\s+code|cursor|zcode/i.test(parsed.note), "提示不写宿主名");
    // stderr 也带规则块（启动前，同一时点）。
    assert.ok(stderr.some((l) => l.includes("以下为 Owner 原文")), "stderr 规则块在场");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("156 CLI --background JSON：无标题退回 runId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-156-cli-bg2-"));
  try {
    makeGitRepo(dir);
    const registryPath = writeRegistry(dir, ["fixture-lane"]);
    const cfg = baseConfig(dir, registryPath, {
      dispatchRunFn: async () => ({ accepted: true, runId: "run_156_bg_fallback", agentId: "fixture-lane", transcriptPath: "/x.jsonl" }),
    });
    const { stdout } = await withCapturedConsole(async () => {
      await runCommand(["fixture-lane", "--background", "--prompt", "---"], cfg);
    });
    const parsed = JSON.parse(stdout.join("\n"));
    assert.equal(parsed.label, "[fixture-lane] run_156_bg_fallback", "取不到标题退回 runId");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("156 CLI 前台：文本格式带 label: 一行；--format json 带 laneRules 不带 label", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-156-cli-fg-"));
  try {
    makeGitRepo(dir);
    const registryPath = writeRegistry(dir, ["fixture-lane"]);
    const capture = { spawned: 0 };
    const cfg = baseConfig(dir, registryPath, { backendFor: () => fakeBackendFactory(capture) });
    const { stdout } = await withCapturedConsole(async () => {
      await runCommand(["fixture-lane", "--prompt", "# 夹具任务\n正文"], cfg);
    });
    const labelLines = stdout.filter((l) => l.startsWith("label: "));
    assert.equal(labelLines.length, 1, "文本格式恰一行 label");
    assert.equal(labelLines[0], "label: [fixture-lane] 夹具任务");

    const { stdout: jsonOut } = await withCapturedConsole(async () => {
      await runCommand(["fixture-lane", "--prompt", "# 夹具任务\n正文", "--format", "json"], cfg);
    });
    const parsed = JSON.parse(jsonOut.join("\n"));
    assert.deepEqual(parsed.laneRules, FAKE_RULES, "前台 JSON 带 laneRules");
    assert.equal("label" in parsed, false, "label 不进前台 JSON（归 --background 与 MCP 回执）");
    assert.equal(capture.spawned, 2, "两次前台派发照常完成");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
