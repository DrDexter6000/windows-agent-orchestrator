// test/isolation-infra/runsMigrateProjects.test.js
//
// TD-190 D3/D2-②a：迁移计划器的记录事实优先语义（opus 补强#1）——首事件在档
// project 事实 > 重推导（规则演进不拆旧桶）；legacy 无事实回退推导。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planProjectsMigration } from "../../src/application/runsMigrateProjects.js";

function seed(runDir, runId, cwd, projectFact) {
  const lines = [
    JSON.stringify({
      type: "run.started", runId, agentId: "tester", cwd, ts: new Date().toISOString(), seq: 0,
      ...(projectFact ? { project: projectFact } : {}),
    }),
    JSON.stringify({ type: "run.state_change", runId, to: "completed", reason: "completion", ts: new Date().toISOString(), seq: 1 }),
  ];
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

test("TD-190 计划器: 记录事实优先于推导（规则演进不拆旧桶）+ legacy 回退", () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-mp-"));
  try {
    // legacy（无事实）：按 cwd 推导 → 主仓桶
    seed(runDir, "run_legacy_1", "D:/projects/windows-agent-orchestrator-poc");
    // 新档（事实在档）：cwd 相同但事实 key 指向另一项目——事实必须赢
    seed(runDir, "run_fact_1", "D:/projects/windows-agent-orchestrator-poc", {
      kind: "project",
      rulesVersion: "td190-r2",
      key: "d:/projects/other-project",
      bucket: "other-project-11111111",
    });
    // 新档 sandbox 事实（cwd 也长着沙箱样，双保险一致）
    seed(runDir, "run_fact_sb", "C:/probe-wt/.codex/worktrees/w1/repo", {
      kind: "sandbox", rulesVersion: "td190-r2", key: "_sandbox",
      harness: "codex", worktreeName: "w1", repoHint: "repo",
    });

    const plan = planProjectsMigration({ runDir, io: { realpath: (p) => p, tmpdir: "C:/PROBE-TMP" } });
    assert.equal(plan.rulesVersion, "td190-r2");
    // 两个项目桶：主仓（legacy 推导）+ other-project（事实钦定 slug 原样采用）
    const slugs = plan.buckets.map((b) => b.slug).sort();
    assert.deepEqual(slugs, [
      "other-project-11111111",
      "windows-agent-orchestrator-poc-" + plan.buckets.find((b) => b.projectKey === "d:/projects/windows-agent-orchestrator-poc").slug.split("-").pop(),
    ].sort(), "事实桶用记录的 bucket，legacy 桶用推导 slug");
    const factBucket = plan.buckets.find((b) => b.slug === "other-project-11111111");
    assert.equal(factBucket.fileCount, 1);
    assert.equal(plan.sandboxFileCount, 1, "sandbox 事实直接进 _sandbox 计数");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("TD-190 计划器: 保留目录跳过 + 非终态跳过 + 解析失败如实", () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-mp2-"));
  try {
    mkdirSync(join(runDir, "reliability"));
    writeFileSync(join(runDir, "reliability", "run_rel.jsonl"), "{}\n", "utf8");
    // 非终态：无终态事实 → 各桶/类别一律跳过点名
    writeFileSync(join(runDir, "run_open.jsonl"),
      JSON.stringify({ type: "run.started", runId: "run_open", agentId: "t", cwd: "D:/projects/x", ts: "2026-10-09T00:00:00Z", seq: 0 }) + "\n",
      "utf8");
    // 解析失败：首行坏 JSON
    writeFileSync(join(runDir, "run_bad.jsonl"), "{not-json\n", "utf8");
    const plan = planProjectsMigration({ runDir, io: { realpath: (p) => p, tmpdir: "C:/PROBE-TMP" } });
    assert.deepEqual(plan.reservedDirsSkipped, ["reliability"]);
    assert.equal(plan.scanned, 2, "保留目录内文件不扫");
    assert.equal(plan.parseFailures.length, 1);
    assert.match(plan.parseFailures[0].reason, /unreadable|not in/);
    const b = plan.buckets[0];
    assert.equal(b.fileCount, 0);
    assert.deepEqual(b.skippedNonTerminal, ["run_open.jsonl"]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
