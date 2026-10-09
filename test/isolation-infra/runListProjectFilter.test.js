// test/isolation-infra/runListProjectFilter.test.js
//
// TD-190 D3 只读过滤（2026-10-09 断点续接项①）：runs list --project 的服务层
// 判定——路径键精确匹配 / 裸名与 slug 大小写不敏感匹配 / @sandbox/@scratch/
// @unattributed 三选择器 / 与 latest 正交。夹具=mkdtemp 下的合成转录（三个
// 项目 + 沙箱 + 临时 + "." 无法归因），零布局变化（只读过滤）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns } from "../../src/application/runList.js";

function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "wao-pf-proj-"));
}

function seed(runDir, runId, cwd) {
  const lines = [
    JSON.stringify({ type: "run.started", runId, agentId: "tester", cwd, ts: new Date().toISOString(), seq: 0 }),
    JSON.stringify({ type: "run.state_change", runId, to: "completed", reason: "completion", ts: new Date().toISOString(), seq: 1 }),
  ];
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

const MAIN = "D:/projects/windows-agent-orchestrator-poc";
const OTHER = "D:/projects/carloha_fde";

test("TD-190 projectFilter: 路径键/裸名/slug 匹配与三选择器（只读，零布局变化）", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_main_1", MAIN);
    seed(runDir, "run_main_2", MAIN.replace(/\//g, "\\")); // 分隔符混写=同键
    seed(runDir, "run_other_1", OTHER);
    seed(runDir, "run_sandbox_1", "C:/Users/17865/.codex/worktrees/wt-x/some-repo");
    seed(runDir, "run_scratch_1", `${tmpdir().replace(/\\/g, "/")}/wao-probe-tmp`);
    seed(runDir, "run_unattr_1", ".");

    // 路径精确（含反斜杠混写归一）
    const byPath = await listRuns({ runDir, projectFilter: MAIN, knownAgentIds: [] });
    assert.deepEqual(byPath.runs.map((r) => r.runId).sort(), ["run_main_1", "run_main_2"]);

    // 裸名（大小写不敏感；slug 前缀同源）
    const byName = await listRuns({ runDir, projectFilter: "CARLOHA_FDE", knownAgentIds: [] });
    assert.deepEqual(byName.runs.map((r) => r.runId), ["run_other_1"]);

    // 三选择器
    const sandbox = await listRuns({ runDir, projectFilter: "@sandbox", knownAgentIds: [] });
    assert.deepEqual(sandbox.runs.map((r) => r.runId), ["run_sandbox_1"]);
    const scratch = await listRuns({ runDir, projectFilter: "@scratch", knownAgentIds: [] });
    assert.deepEqual(scratch.runs.map((r) => r.runId), ["run_scratch_1"]);
    const unattr = await listRuns({ runDir, projectFilter: "@unattributed", knownAgentIds: [] });
    assert.deepEqual(unattr.runs.map((r) => r.runId), ["run_unattr_1"]);

    // 未命中=空集（不报错）
    const miss = await listRuns({ runDir, projectFilter: "no-such-project", knownAgentIds: [] });
    assert.equal(miss.runs.length, 0);

    // 与 latest 正交
    const latest1 = await listRuns({ runDir, projectFilter: MAIN, latest: 1, knownAgentIds: [] });
    assert.equal(latest1.runs.length, 1);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
