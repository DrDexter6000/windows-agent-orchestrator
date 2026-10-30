// test/application/laneFactsLine.test.js
//
// 0097 §4：派发受理回显所选车道一行事实的钉：
//   - 单元（纯投影，夹具注入）：只列已评维度（Owner 评写"（Owner）"、未评不列、
//     measured 带 n 与 score）、成本档（null 写"成本档未给"）、评分状态（待复核
//     写"评分待复核"）、一行无换行、长度上限、控制字符转义（TD-318/319）；
//     不出现其他车道名，不出现"更便宜""建议""应该"；
//   - fail-open：画像读失败/车道不在画像/投影 null → 返回 null，不抛；
//   - CLI `wao run`：派发那一刻打到 stderr 的恰一行 `[wao] ` 前缀（前台与后台
//     共用的打印点；dispatchHold advisory 同款纪律），回显失败（null）不打印、
//     派发照常完成（dispatchHold.test.js 同款夹具与注入缝）。
process.env.WAO_ALLOW_NESTED_DISPATCH = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import {
  laneFactsLine,
  LANE_FACTS_LINE_MAX_CHARS,
} from "../../src/application/laneFactsLine.js";
import { runCommand } from "../../src/commands/run.js";
import { readRegistry } from "../../src/registry.js";

// ── 夹具（与 laneProfile.test.js 同形；只造回显行需要的三种格）──────────────

const unrated = () => ({ stars: null, basis: null });
const scale = { "5": "最强", "4": "强", "3": "堪用", "2": "弱", "1": "不适合" };

const baseEntry = (over = {}) => ({
  ratings: {
    research: unrated(), code: unrated(), review: unrated(), design: unrated(),
    longHorizon: unrated(), writing: unrated(), visual: unrated(),
  },
  ratedAgainst: null,
  cost: "按量计费",
  costTier: null,
  caveats: [],
  contextWindow: { tokens: 1000000, source: "official（测试）" },
  multimodal: { image: true, video: false, source: "official" },
  ...over,
});

const LANES_DOC = {
  ok: true, sha256: "a".repeat(64), issues: [],
  lanes: [
    { id: "full-lane", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } },
    { id: "bare-lane", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } },
    { id: "stale-lane", backend: "zcode", model: { id: "m-changed" }, reasoning: { effort: "max" } },
    { id: "untouched-lane", backend: "codex", model: { id: "m2" }, reasoning: { effort: "high" } },
  ],
};

const traitsResult = {
  state: "ok", path: "fixture.json", sha256: "b".repeat(64), scale,
  costTierScale: "成本档：Owner 给的相对档位", ownerRules: ["规则一"],
  observations: [],
  traits: {
    "full-lane": baseEntry({
      costTier: 1,
      ratings: {
        research: { stars: 3, basis: "measured", n: 99, evidence: "e", score: { hits: 68, total: 99, label: "与终裁一致" } },
        code: { stars: 3, basis: "measured", n: 2, evidence: "e", score: { hits: 26, total: 28, label: "隐藏测试通过" } },
        review: { stars: 3, basis: "measured", n: 19, evidence: "e" }, // 实测无 score
        design: { stars: 4, basis: "owner", note: "方案 advisor" },
        longHorizon: unrated(), writing: unrated(), visual: unrated(),
      },
      ratedAgainst: { backend: "zcode", modelId: "m1", providerID: null, effort: "max" },
    }),
    "bare-lane": baseEntry({}),
    "stale-lane": baseEntry({
      ratings: {
        research: { stars: 3, basis: "measured", n: 5, evidence: "e" },
        code: unrated(), review: unrated(), design: unrated(),
        longHorizon: unrated(), writing: unrated(), visual: unrated(),
      },
      ratedAgainst: { backend: "zcode", modelId: "m1", providerID: null, effort: "max" },
    }),
  },
  invalidIds: [], issues: [],
};

// ── 单元 ─────────────────────────────────────────────────────────────────────

test("回显行：已评维度按声明序列出；Owner 评写（Owner）；未评不列；score 跟 n", () => {
  const line = laneFactsLine("full-lane", { lanesDoc: LANES_DOC, traitsResult });
  assert.ok(typeof line === "string" && line.length > 0);
  assert.ok(line.startsWith("所选车道事实（只陈列，不是推荐）：full-lane · "), "前缀与车道键");
  assert.ok(line.includes("成本档 1（Owner 相对档 0.5–5，非价格倍数）"), "成本档带说明");
  assert.ok(line.includes("调研整理 3★（n=99，68/99）"), "measured 带 score");
  assert.ok(line.includes("写代码 3★（n=2，26/28）"), "code 格");
  assert.ok(line.includes("抓 bug/把关 3★（n=19）"), "实测无 score 只带 n");
  assert.ok(line.includes("方案设计 4★（Owner）"), "Owner 评格");
  assert.ok(!line.includes("长程自主"), "未评维度不列");
  assert.ok(line.endsWith("评分当前；Owner 规则见 lead_preflight 的 lanes.ownerRules"));
  // 声明序：research 在 code 前、code 在 review 前、design 在最后。
  const order = ["调研整理", "写代码", "抓 bug/把关", "方案设计"].map((k) => line.indexOf(k));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "维度按 RATING_DIMENSIONS 声明序");
});

test("回显行：成本档未给、评分待复核、全未评车道", () => {
  const bare = laneFactsLine("bare-lane", { lanesDoc: LANES_DOC, traitsResult });
  assert.ok(bare.includes("成本档未给"), "成本档 null 写未给");
  assert.ok(bare.includes("评分未评"), "全未评的评分状态");
  assert.ok(!/★/.test(bare), "无已评维度时无星号段");
  const stale = laneFactsLine("stale-lane", { lanesDoc: LANES_DOC, traitsResult });
  assert.ok(stale.includes("评分待复核"), "身份不一致 → 待复核");
});

test("回显行：不出现其他车道名与推荐词；一行无换行；长度上限", () => {
  const line = laneFactsLine("full-lane", { lanesDoc: LANES_DOC, traitsResult });
  for (const other of ["bare-lane", "stale-lane", "untouched-lane"]) {
    assert.ok(!line.includes(other), `不出现其他车道名 ${other}`);
  }
  for (const banned of ["更便宜", "建议", "应该"]) {
    assert.ok(!line.includes(banned), `不出现推荐词"${banned}"`);
  }
  assert.ok(!/[\n\r\u2028\u2029]/.test(line), "一行无换行");
  assert.ok(line.length <= LANE_FACTS_LINE_MAX_CHARS, "长度在上限内");
  assert.equal(LANE_FACTS_LINE_MAX_CHARS, 480, "上限常量 ≤480（MCP schema 引用同一值）");
});

test("回显行：车道键里的控制字符按 TD-318/319 转义（不增殖行数）", () => {
  const evilDoc = {
    ...LANES_DOC,
    lanes: [...LANES_DOC.lanes, { id: "evil\u0007lane", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } }],
  };
  const evilTraits = {
    ...traitsResult,
    traits: { ...traitsResult.traits, "evil\u0007lane": baseEntry({}) },
  };
  const line = laneFactsLine("evil\u0007lane", { lanesDoc: evilDoc, traitsResult: evilTraits });
  assert.ok(line.includes("evil\\u0007lane"), "控制字节可见化（escapeControlChars 的 \\u0007 写法）");
  assert.ok(!/[\u0000-\u001f]/.test(line), "行内无原始控制字节");
});

test("fail-open：画像读失败/车道不在画像/投影 null → null，不抛", () => {
  assert.equal(laneFactsLine("untouched-lane", { lanesDoc: LANES_DOC, traitsResult }), null,
    "车道表里、画像里没有 → null");
  assert.equal(laneFactsLine("ghost", { lanesDoc: LANES_DOC, traitsResult }), null, "未知键 → null");
  assert.equal(laneFactsLine("full-lane", {
    lanesDoc: LANES_DOC,
    traitsResult: { state: "unreadable", sha256: null, scale: null, traits: {}, invalidIds: [], issues: [], observations: [] },
  }), null, "画像不可读 → null");
  assert.equal(laneFactsLine("full-lane", {
    lanesDoc: { ok: false, sha256: null, lanes: [], issues: ["结构坏"] },
    traitsResult,
  }), null, "车道表不可用（非默认 --registry 同形）→ null");
  assert.equal(laneFactsLine(undefined, { lanesDoc: LANES_DOC, traitsResult }), null, "无目标键 → null");
  // 读取函数抛错也吞掉（fail-open 的兜底 catch）。
  assert.equal(laneFactsLine("full-lane", {
    get lanesDoc() { throw new Error("boom"); },
    traitsResult,
  }), null, "输入抛错 → null 不上抛");
});

// ── CLI：派发那一刻打到 stderr（dispatchHold advisory 同款纪律）──────────────

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md && git commit -m init", { cwd: dir, stdio: "pipe" });
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
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => { stderr.push(a.join(" ")); };
  console.log = () => {};
  try { await fn(); } finally {
    console.error = origErr;
    console.log = origLog;
  }
  return { stderr };
}

const FACTS_LINE = "所选车道事实（只陈列，不是推荐）：fixture-lane · 成本档 1（Owner 相对档 0.5–5，非价格倍数）· 评分当前；Owner 规则见 lead_preflight 的 lanes.ownerRules";

test("CLI wao run：派发那一刻 stderr 恰一行 `[wao] ` 前缀回显；派发照常完成", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0097-cli-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { "fixture-lane": { backend: "claude-code", cwd: dir } } }), "utf8");
    const capture = { spawned: 0 };
    const cfg = {
      registry: registryPath,
      runDir: join(dir, "runs"),
      readRegistry: async () => readRegistry(registryPath),
      backendFor: () => fakeBackendFactory(capture),
      // 车道表停用形（无夹具表）也行——回显行只依赖注入缝；这里直接注入实现。
      laneFactsLineFn: (laneId) => (laneId === "fixture-lane" ? FACTS_LINE : null),
    };
    const { stderr } = await withCapturedConsole(async () => {
      await runCommand(["fixture-lane", "--prompt", "t"], cfg);
    });
    const factsLines = stderr.filter((l) => l.includes("所选车道事实"));
    assert.equal(factsLines.length, 1, "恰一行回显");
    assert.ok(factsLines[0].startsWith(`[wao] 所选车道事实（只陈列，不是推荐）：fixture-lane`),
      "`[wao] ` 前缀 + 同一行文字");
    assert.equal(capture.spawned, 1, "派发照常完成（回显不拦截）");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI wao run：回显失败（null）不打印，派发照常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0097-cli-null-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { "plain-agent": { backend: "claude-code", cwd: dir } } }), "utf8");
    const capture = { spawned: 0 };
    const cfg = {
      registry: registryPath,
      runDir: join(dir, "runs"),
      readRegistry: async () => readRegistry(registryPath),
      backendFor: () => fakeBackendFactory(capture),
      laneFactsLineFn: () => null,
    };
    const { stderr } = await withCapturedConsole(async () => {
      await runCommand(["plain-agent", "--prompt", "t"], cfg);
    });
    assert.equal(stderr.filter((l) => l.includes("所选车道事实")).length, 0, "null → 零行");
    assert.equal(capture.spawned, 1, "派发照常完成");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
