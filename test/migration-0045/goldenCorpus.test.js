// test/migration-0045/goldenCorpus.test.js
//
// 0045 清账批 CB-4：现行为黄金对照（golden contrast）——身份相邻投影的冻结快照。
//
// 目的：0.3.0 身份模型改造（0045）前后，读取面投影（listRuns 等）对同一输入的
// 输出必须逐字节不变（除合同声明要变的身份字段）。本测试把**当前**行为冻成
// 内嵌快照：夹具复刻真实案卷的六种身份形状（R2 会审实测 590 份里的全部边类），
// 任何非蓄意的投影行为变化（排序、字段名、unknown 折叠、状态机）在此即红。
//
// 夹具形状来源（真实案卷实测，collected2 R2 会审）：
//   normal（585/590 有 run.started 全字段）、legacy 组合（coder_hq 曾 claude-code
//   ×121）、缺 run.started（5 份）、缺 model（7 份真实样本形状）、缺 providerKey、
//   缺 reasoning（82 份）。run.started 字段形状复刻
//   runs/reliability/run_20261002001608853n0uuc1.jsonl 实测。
//
// 快照更新纪律：只有 0045 合同声明的身份字段变化允许更新本快照，且提交信息
// 必须引用 0045 条款号；其余变化=回归，修代码不改快照。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns } from "../../src/application/runList.js";

function writeRun(dir, runId, events) {
  writeFileSync(join(dir, `${runId}.jsonl`), `${events.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
}

const TS = "2026-10-05T00:00:00.000Z";
const CORPUS = [
  {
    shape: "normal-zcode-full",
    runId: "run_gold_normal",
    events: [
      { type: "run.started", runId: "run_gold_normal", agentId: "coder_hq", backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, reasoning: { effort: "high" }, providerKey: "pk-gold-zcode", ts: TS, seq: 1 },
      { type: "run.state_change", runId: "run_gold_normal", agentId: "coder_hq", from: "pending", to: "running", reason: "first_event", ts: TS, seq: 2 },
      { type: "run.completed", runId: "run_gold_normal", agentId: "coder_hq", ts: TS, seq: 3 },
    ],
  },
  {
    shape: "legacy-combo-claude-code-era",
    runId: "run_gold_legacy",
    events: [
      { type: "run.started", runId: "run_gold_legacy", agentId: "coder_hq", backend: "claude-code", model: { id: "glm-5.3[1m]" }, reasoning: { effort: "max" }, providerKey: "pk-gold-claude", ts: TS, seq: 1 },
      { type: "run.state_change", runId: "run_gold_legacy", agentId: "coder_hq", from: "pending", to: "running", reason: "first_event", ts: TS, seq: 2 },
      { type: "run.completed", runId: "run_gold_legacy", agentId: "coder_hq", ts: TS, seq: 3 },
    ],
  },
  {
    shape: "missing-run-started",
    runId: "run_gold_no_started",
    events: [
      { type: "run.state_change", runId: "run_gold_no_started", agentId: "researcher", from: "pending", to: "running", reason: "first_event", ts: TS, seq: 1 },
      { type: "run.completed", runId: "run_gold_no_started", agentId: "researcher", ts: TS, seq: 2 },
    ],
  },
  {
    shape: "missing-model",
    runId: "run_gold_no_model",
    events: [
      { type: "run.started", runId: "run_gold_no_model", agentId: "tester", backend: "codex", reasoning: { effort: "xhigh" }, providerKey: "pk-gold-codex", ts: TS, seq: 1 },
      { type: "run.completed", runId: "run_gold_no_model", agentId: "tester", ts: TS, seq: 2 },
    ],
  },
  {
    shape: "missing-providerKey",
    runId: "run_gold_no_pk",
    events: [
      { type: "run.started", runId: "run_gold_no_pk", agentId: "auditor", backend: "codex", model: { id: "gpt-6-astra" }, reasoning: { effort: "xhigh" }, ts: TS, seq: 1 },
      { type: "run.completed", runId: "run_gold_no_pk", agentId: "auditor", ts: TS, seq: 2 },
    ],
  },
  {
    shape: "missing-reasoning",
    runId: "run_gold_no_reasoning",
    events: [
      { type: "run.started", runId: "run_gold_no_reasoning", agentId: "retired_seat", backend: "opencode-serve", model: { id: "deepseek-v4-flash" }, providerKey: "pk-gold-opencode", ts: TS, seq: 1 },
      { type: "run.completed", runId: "run_gold_no_reasoning", agentId: "retired_seat", ts: TS, seq: 2 },
    ],
  },
];

// 冻结的黄金快照（0045 CB-4 生成于 2026-10-05，listRuns {runId: row} 归一键化，
// 剔除时敏字段）。knownAgentIds=[coder_hq, tester]：同时钉住两种现行为——在册席
// 显示原名、**离册席 agentId 字段本身折叠 "unknown"**（runList.js:164-168 实测
// 现行为，R2 会审 590 份历史离册名全显 unknown 的病根即此；0045 §1.5 legacy
// 名单落地时此快照按合同条款更新）。
const GOLDEN = {
  "run_gold_legacy": { "agentId": "coder_hq", "state": "completed", "terminal": true, "activityStatus": "terminal" },
  "run_gold_no_model": { "agentId": "tester", "state": "completed", "terminal": true, "activityStatus": "terminal" },
  "run_gold_no_pk": { "agentId": "unknown", "state": "completed", "terminal": true, "activityStatus": "terminal" },
  "run_gold_no_reasoning": { "agentId": "unknown", "state": "completed", "terminal": true, "activityStatus": "terminal" },
  "run_gold_no_started": { "agentId": "unknown", "state": "completed", "terminal": true, "activityStatus": "terminal" },
  "run_gold_normal": { "agentId": "coder_hq", "state": "completed", "terminal": true, "activityStatus": "terminal" },
};

test("0045 CB-4 黄金对照：六身份形状的 listRuns 投影冻结（改造前行为基线）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0045-golden-"));
  try {
    for (const c of CORPUS) writeRun(dir, c.runId, c.events);
    const { runs } = await listRuns({
      runDir: dir,
      knownAgentIds: ["coder_hq", "tester"],
      validateAgentIds: true,
      nowMs: Date.parse(TS) + 60_000,
      checkLivenessFn: () => "unknown",
    });
    const byId = {};
    for (const row of runs) byId[row.runId] = {
      agentId: row.agentId,
      state: row.state,
      terminal: row.terminal,
      activityStatus: row.activityStatus,
    };
    assert.deepEqual(Object.keys(byId).sort(), Object.keys(GOLDEN).sort(),
      "夹具六 run 全部出现在投影中");
    assert.deepEqual(byId, GOLDEN,
      "listRuns 身份投影与 0045 冻结基线不符——非合同声明的行为变化=回归，修代码不改快照；"
      + "合同声明的变化（0045 §1.5 自描述派生/legacy 名单）须引用条款更新本快照");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
