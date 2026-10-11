// test/isolation-infra/runsMigrateProjects.test.js
//
// TD-190 D3/D2-②a：迁移计划器的记录事实优先语义（opus 补强#1）——首事件在档
// project 事实 > 重推导（规则演进不拆旧桶）；legacy 无事实回退推导。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planProjectsMigration, applyProjectsMigration, verifyProjectsMigration } from "../../src/application/runsMigrateProjects.js";
import { deriveProjectBucketSlug } from "../../src/projectIdentity.js";
import { resolveTranscriptPath } from "../../src/projectBuckets.js";

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

// ═══ TD-256 批：apply / verify（link+sha 原语、manifest 幂等四态、事实适配）═══

function seedNonTerminal(runDir, runId, cwd) {
  const lines = [
    JSON.stringify({ type: "run.started", runId, agentId: "tester", cwd, ts: new Date().toISOString(), seq: 0 }),
    JSON.stringify({ type: "run.state_change", runId, to: "running", ts: new Date().toISOString(), seq: 1 }),
  ];
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

test("TD-256 apply: 迁移全链（project+unattributed+非终态不动）+ 新址解析 + manifest intent/result 双行", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-ma-"));
  try {
    const runDir = join(root, "runs");
    const manifestDir = join(root, ".wao", "migration", "td190-d3");
    mkdirSync(runDir, { recursive: true });
    const projCwd = join(root, "proj-a").replace(/\\/g, "/");
    seed(runDir, "run_ok", projCwd);
    seed(runDir, "run_unattr", undefined); // 无 cwd → unattributed
    seedNonTerminal(runDir, "run_open", projCwd);
    const io = { realpath: (p) => p };

    const r1 = applyProjectsMigration({ runDir, manifestDir, io, stamp: "t1" });
    assert.equal(r1.totals.migrated, 2, "project+unattributed 各一");
    assert.equal(r1.totals.keptNonTerminal, 1, "非终态不动（fail-closed）");
    assert.equal(r1.totals.failures, 0);
    // 新址经解析链可达（无孪生歧义）
    assert.ok(resolveTranscriptPath(runDir, "run_ok", { io }).includes(join("projects")), `run_ok 新址在桶内：${resolveTranscriptPath(runDir, "run_ok", { io })}`);
    assert.ok(resolveTranscriptPath(runDir, "run_unattr", { io }).includes("_unattributed"), "unattributed 落 _unattributed 桶");
    // 根层只剩非终态
    assert.deepEqual(readdirSync(runDir).filter((n) => n.endsWith(".jsonl")).sort(), ["run_open.jsonl"]);
    // manifest：intent/result 双行、含 sha/slug/kind/rulesVersion
    const manifestText = readFileSync(join(manifestDir, "apply-t1.jsonl"), "utf8");
    const lines = manifestText.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.phase === "intent").length, 2);
    assert.equal(lines.filter((l) => l.phase === "result" && l.op === "migrate").length, 2);
    for (const l of lines) {
      assert.equal(typeof l.sha256, "string");
      assert.equal(typeof l.slug, "string");
      assert.equal(l.rulesVersion, "td190-r2");
    }
    const unattrIntent = lines.find((l) => l.runId === "run_unattr" && l.phase === "intent");
    assert.equal(unattrIntent.kind, "unattributed");
    assert.ok(unattrIntent.reason, "unattributed 行带原因（opus 会审）");
    // 幂等重跑：已迁文件不在根层、不进循环——重跑=零新动作零错误；
    // 已迁归属由 verify 从既往 manifest 证明（dst 全在场、sha 无漂移、无再现）。
    const r2 = applyProjectsMigration({ runDir, manifestDir, io, stamp: "t2" });
    assert.equal(r2.totals.scanned, 1, "重跑只见到剩余的非终态文件");
    assert.equal(r2.totals.migrated, 0);
    assert.equal(r2.totals.failures, 0);
    assert.equal(r2.totals.anomalies, 0);
    assert.equal(r2.totals.keptNonTerminal, 1);
    assert.equal(r2.totals.alreadyMigrated, 2, "验收 sol#2：台账补判在 apply 自身闭环（仅 dst 由既往 manifest 证明）");
    const v = verifyProjectsMigration({ runDir, manifestDir, io });
    assert.equal(v.dstTotal, 2, "manifest 台账两项已迁");
    assert.equal(v.dstMissing.length, 0);
    assert.equal(v.shaMismatch.length, 0);
    assert.equal(v.reappeared.length, 0);
    assert.deepEqual(v.rootRemainder, ["run_open.jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-256 apply: 幂等孪生态——双在同 hash 删平铺侧；双在异 hash 拒不覆盖；verify 点名 sha 漂移/再现", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-mb-"));
  try {
    const runDir = join(root, "runs");
    const manifestDir = join(root, ".wao", "migration", "td190-d3");
    mkdirSync(runDir, { recursive: true });
    const projCwd = join(root, "proj-b").replace(/\\/g, "/");
    seed(runDir, "run_twin", projCwd);
    const io = { realpath: (p) => p };
    const r1 = applyProjectsMigration({ runDir, manifestDir, io, stamp: "t1" });
    assert.equal(r1.totals.migrated, 1);
    const dst = r1.items.find((i) => i.runId === "run_twin").dst;
    // 双在同 hash（复活一个相同内容的平铺副本）→ 删平铺侧
    const original = readFileSync(dst, "utf8");
    writeFileSync(join(runDir, "run_twin.jsonl"), original, "utf8");
    const r2 = applyProjectsMigration({ runDir, manifestDir, io, stamp: "t2" });
    assert.equal(r2.totals.droppedFlatTwin, 1);
    // 双在异 hash → twin_conflict 拒、dst 不动
    writeFileSync(join(runDir, "run_twin.jsonl"), original + JSON.stringify({ type: "x" }) + "\n", "utf8");
    const r3 = applyProjectsMigration({ runDir, manifestDir, io, stamp: "t3" });
    assert.equal(r3.totals.twinConflicts, 1);
    assert.equal(readFileSync(dst, "utf8"), original, "冲突时目标文件逐字节不动");
    // verify：dst sha 漂移（模拟迁移后合法追加）与根层再现（并发追加复活）被点名
    const v1 = verifyProjectsMigration({ runDir, manifestDir, io });
    assert.equal(v1.reappeared.length, 1, "根层再现=run_twin（冲突平铺副本在场）");
    writeFileSync(dst, original + JSON.stringify({ type: "run.lineage_closed", runId: "run_twin" }) + "\n", "utf8");
    const v2 = verifyProjectsMigration({ runDir, manifestDir, io });
    assert.equal(v2.shaMismatch.length, 1, "dst 追加后 sha 漂移被点名（只报告不回滚）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-256 验收 sol#4: 终态推导信封绑定——外 run 的 completed 尾条不把 running 文件翻成可迁", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-mf-"));
  try {
    const runDir = join(root, "runs");
    const manifestDir = join(root, ".wao", "migration", "td190-d3");
    mkdirSync(runDir, { recursive: true });
    const projCwd = join(root, "proj-f").split("\\").join("/");
    const lines = [
      JSON.stringify({ type: "run.started", runId: "run_stuck", agentId: "tester", cwd: projCwd, ts: "x", seq: 0 }),
      JSON.stringify({ type: "run.state_change", runId: "run_stuck", to: "running", ts: "x", seq: 1 }),
      JSON.stringify({ type: "run.state_change", runId: "run_OTHER", to: "completed", ts: "x", seq: 2 }),
    ];
    writeFileSync(join(runDir, "run_stuck.jsonl"), lines.join("\n") + "\n", "utf8");
    const r = applyProjectsMigration({ runDir, manifestDir, io: { realpath: (pp) => pp }, stamp: "t1" });
    assert.equal(r.totals.keptNonTerminal, 1, "外 run completed 不认——本文件仍 running");
    assert.equal(r.totals.migrated, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("TD-256 apply: 在档事实适配——缺 displayName 补 basename；畸形事实入口拒；事实桶≠权威冻结桶拒绝", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-mc-"));
  try {
    const runDir = join(root, "runs");
    const manifestDir = join(root, ".wao", "migration", "td190-d3");
    mkdirSync(runDir, { recursive: true });
    // keyA：无既有权威桶——一致事实（缺 displayName）补 basename 后正常迁移。
    const keyA = "d:/x/proj-consistent";
    const bucketA = deriveProjectBucketSlug({ kind: "project", key: keyA, displayName: "proj-consistent" });
    seed(runDir, "run_fact_good", "D:/anywhere", { kind: "project", rulesVersion: "td190-r2", key: keyA, bucket: bucketA });
    // keyB：权威索引已冻结更长哈希桶（碰撞延长形态）——自洽事实桶(hash8) ≠ 权威桶。
    const keyB = "d:/x/proj-collided";
    const bucketB8 = deriveProjectBucketSlug({ kind: "project", key: keyB, displayName: "proj-collided" });
    const bucketB12 = bucketB8 + "abcdef"; // 更长哈希段=合法冻结形态（-[0-9a-f]{8,}$）
    seed(runDir, "run_fact_frozen", "D:/anywhere", { kind: "project", rulesVersion: "td190-r2", key: keyB, bucket: bucketB8 });
    const frozenDir = join(runDir, "projects", bucketB12);
    mkdirSync(frozenDir, { recursive: true });
    writeFileSync(join(frozenDir, ".project.json"), JSON.stringify({
      key: keyB, slug: bucketB12, displayName: "proj-collided", rulesVersion: "td190-r2", createdAt: new Date().toISOString(), aliases: [],
    }), "utf8");
    // keyC：畸形事实（bucket 与 key 推导不符）——identityOfFirstEvent 入口即拒。
    seed(runDir, "run_fact_malformed", "D:/anywhere", { kind: "project", rulesVersion: "td190-r2", key: keyA, bucket: "zzz-mismatch" });
    const io = { realpath: (p) => p };
    const r = applyProjectsMigration({ runDir, manifestDir, io, stamp: "t1" });
    assert.equal(r.totals.migrated, 1, "一致事实迁移成功（displayName 由 basename 补齐）");
    assert.equal(r.totals.factBucketMismatches, 1, "自洽事实桶 ≠ 权威冻结桶 → 拒绝上报");
    const frozen = r.items.find((i) => i.runId === "run_fact_frozen");
    assert.equal(frozen.status, "refused:fact_bucket_mismatch");
    assert.match(frozen.detail, new RegExp(bucketB12));
    assert.equal(r.totals.failures, 1, "畸形事实入口拒（identityOfFirstEvent factError）");
    assert.equal(r.items.find((i) => i.runId === "run_fact_malformed").status, "failed:fact_rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-256 apply: link EPERM → 单项失败不中止整批", async () => {  const root = mkdtempSync(join(tmpdir(), "wao-md-"));
  try {
    const runDir = join(root, "runs");
    const manifestDir = join(root, ".wao", "migration", "td190-d3");
    mkdirSync(runDir, { recursive: true });
    const cwdA = join(root, "pa").replace(/\\/g, "/");
    const cwdB = join(root, "pb").replace(/\\/g, "/");
    seed(runDir, "run_a", cwdA);
    seed(runDir, "run_b", cwdB);
    const realLink = (await import("node:fs")).linkSync;
    let linkCalls = 0;
    const io = {
      realpath: (p) => p,
      linkSync: (src, dst) => { linkCalls += 1; if (src.endsWith("run_a.jsonl")) { const e = new Error("busy"); e.code = "EPERM"; throw e; } realLink(src, dst); },
    };
    const r = applyProjectsMigration({ runDir, manifestDir, io, stamp: "t1" });
    assert.equal(r.totals.failures, 1, "EPERM 单项失败");
    assert.equal(r.totals.migrated, 1, "整批继续（run_b 迁移成功）");
    assert.equal(r.items.find((i) => i.runId === "run_a").status, "failed:link_EPERM");
    assert.equal(linkCalls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-256 CLI 门：--run-dir 生效（dry-run 回显解析路径）+ worktree 内拒绝", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  const root = mkdtempSync(join(tmpdir(), "wao-me-"));
  try {
    const runDir = join(root, "runs");
    mkdirSync(runDir, { recursive: true });
    const original = console.log;
    const lines = [];
    console.log = (...a) => { lines.push(a.map(String).join(" ")); };
    const savedExit = process.exitCode;
    try {
      await runsCommand(["migrate-projects", "--run-dir", runDir], { runDir: "somewhere-else" });
    } finally {
      console.log = original;
      process.exitCode = savedExit;
    }
    assert.ok(lines.some((l) => l.includes(runDir)), `dry-run 回显 --runDir 解析路径（opus 会审 Q5-5）：${lines[1] ?? lines[0]}`);
    // worktree 内执行 → 拒绝（旧代码忽略 --run-dir 时会对着空/错目录跑）
    await assert.rejects(
      runsCommand(["migrate-projects", "--run-dir", join(root, ".wao-worktrees", "run_x", "runs")], {}),
      /worktree/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
