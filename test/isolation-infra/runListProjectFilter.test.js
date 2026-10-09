// test/isolation-infra/runListProjectFilter.test.js
//
// TD-190 D3 只读过滤（2026-10-09 断点续接项①；终审 M6/F4 修正版）：
// runs list --project 的服务层判定——路径键精确匹配 / 裸名·slug 大小写不敏感
// 匹配（不走 realpath）/ @sandbox/@scratch/@unattributed 闭集选择器（未知值
// 报错）/ 在档归属事实优先（F4：事实在册而 cwd 已失效的 run 不落
// @unattributed）/ 与 latest 正交。
// 夹具纪律（终审 M6）：项目目录建在 mkdtemp 下、io 注入——测试不依赖本机
// 真实路径，换机/挪仓不红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns } from "../../src/application/runList.js";
import { projectFactFromCwd } from "../../src/projectIdentity.js";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "wao-pf-proj-"));
  const runDir = join(root, "runs");
  mkdirSync(runDir);
  const projectIo = { realpath: (p) => p, tmpdir: join(root, "scratch-tmp") };
  return { root, runDir, projectIo };
}

function seed(runDir, runId, cwd, projectIo, { withFact = true } = {}) {
  const fact = withFact && cwd ? projectFactFromCwd(cwd, projectIo) : undefined;
  const lines = [
    JSON.stringify({
      type: "run.started", runId, agentId: "tester", cwd, ts: new Date().toISOString(), seq: 0,
      ...(fact ? { project: fact } : {}),
    }),
    JSON.stringify({ type: "run.state_change", runId, to: "completed", reason: "completion", ts: new Date().toISOString(), seq: 1 }),
  ];
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

test("TD-190 projectFilter: 路径键/裸名匹配与三选择器（只读，零布局变化）", async () => {
  const { root, runDir, projectIo } = makeFixture();
  try {
    const MAIN = join(root, "projects", "alpha-suite").replace(/\\/g, "/");
    const OTHER = join(root, "projects", "beta-suite").replace(/\\/g, "/");
    mkdirSync(join(root, "projects", "alpha-suite"), { recursive: true });
    mkdirSync(join(root, "projects", "beta-suite"), { recursive: true });
    const scratchTmp = join(root, "scratch-tmp", "wao-probe-x");
    mkdirSync(join(root, "scratch-tmp", "wao-probe-x"), { recursive: true });

    seed(runDir, "run_main_1", MAIN, projectIo);
    seed(runDir, "run_main_2", MAIN.replace(/\//g, "\\"), projectIo); // 分隔符混写=同键
    seed(runDir, "run_other_1", OTHER, projectIo);
    seed(runDir, "run_sandbox_1", "C:/probe-wt/.codex/worktrees/wt-x/some-repo", projectIo);
    seed(runDir, "run_scratch_1", scratchTmp.replace(/\\/g, "/"), projectIo);
    seed(runDir, "run_unattr_1", ".", projectIo);

    const opts = { runDir, knownAgentIds: [], projectIo };

    // 路径精确（含反斜杠混写归一）
    const byPath = await listRuns({ ...opts, projectFilter: MAIN });
    assert.deepEqual(byPath.runs.map((r) => r.runId).sort(), ["run_main_1", "run_main_2"]);

    // 裸名（大小写不敏感）
    const byName = await listRuns({ ...opts, projectFilter: "BETA-SUITE" });
    assert.deepEqual(byName.runs.map((r) => r.runId), ["run_other_1"]);

    // 三选择器
    assert.deepEqual((await listRuns({ ...opts, projectFilter: "@sandbox" })).runs.map((r) => r.runId), ["run_sandbox_1"]);
    assert.deepEqual((await listRuns({ ...opts, projectFilter: "@scratch" })).runs.map((r) => r.runId), ["run_scratch_1"]);
    assert.deepEqual((await listRuns({ ...opts, projectFilter: "@unattributed" })).runs.map((r) => r.runId), ["run_unattr_1"]);

    // 未知选择器 → 报错（闭集，不静默空集——TD-153 惯例）
    await assert.rejects(
      () => listRuns({ ...opts, projectFilter: "@sandbx" }),
      /unknown --project selector/,
    );

    // 裸名不按路径解析（不含分隔符的相对名不 realpath 成键——终审 F4）
    const relName = await listRuns({ ...opts, projectFilter: "alpha-suite" });
    assert.equal(relName.runs.length, 2, "裸名按 displayName 匹配，不走 realpath");

    // 未命中=空集（不报错）
    assert.equal((await listRuns({ ...opts, projectFilter: "no-such-project" })).runs.length, 0);

    // 与 latest 正交
    assert.equal((await listRuns({ ...opts, projectFilter: MAIN, latest: 1 })).runs.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-190 projectFilter 终审 F4: 在档事实优先——cwd 已失效的 run 不落 @unattributed", async () => {
  const { root, runDir, projectIo } = makeFixture();
  try {
    const alive = join(root, "projects", "alpha-suite").replace(/\\/g, "/");
    mkdirSync(join(root, "projects", "alpha-suite"), { recursive: true });
    // 带 alpha-suite 事实 + 死 cwd（事实与推导分歧：推导会 ENOENT→unattributed）
    writeFileSync(join(runDir, "run_fact_dead_cwd.jsonl"), [
      JSON.stringify({
        type: "run.started", runId: "run_fact_dead_cwd", agentId: "tester",
        cwd: join(root, "gone-project").replace(/\\/g, "/"),
        ts: new Date().toISOString(), seq: 0,
        project: projectFactFromCwd(alive, projectIo),
      }),
      JSON.stringify({ type: "run.state_change", runId: "run_fact_dead_cwd", to: "completed", reason: "completion", ts: new Date().toISOString(), seq: 1 }),
    ].join("\n") + "\n", "utf8");

    const opts = { runDir, knownAgentIds: [], projectIo };
    // 事实在册 → 按 alpha-suite 查得到（事实赢过推导）
    const byName = await listRuns({ ...opts, projectFilter: "alpha-suite" });
    assert.deepEqual(byName.runs.map((r) => r.runId), ["run_fact_dead_cwd"]);
    // 不进 @unattributed
    const unattr = await listRuns({ ...opts, projectFilter: "@unattributed" });
    assert.equal(unattr.runs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
