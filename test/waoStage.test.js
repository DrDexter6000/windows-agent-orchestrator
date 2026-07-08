// waoStage.test.js
//
// TD-83：Lead 阶段声明（stage）读写测试。声明让 Lead 走 pipeline 的进度
// 对用户/dashboard 可见——强制力是曝光不是拦截。
//
// 镜像 waoDeclare.test.js 的 idiom：临时 .wao/ + initWaoDir + addStage + 读回验证。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWaoDir, getWaoDir } from "../src/waoDir.js";
import { addStage, listStages, summarizeStages, STAGE_NUMBERS } from "../src/waoStage.js";

async function makeInitWao() {
  const dir = await mkdtemp(join(tmpdir(), "wao-stage-"));
  await initWaoDir(dir);
  return dir;
}

test("TD-83: addStage 建正文(STAGE- 前缀 + 结构化 frontmatter) + 更新 map", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    const path = await addStage(waoDir, {
      stage: 1,
      task: "起草 /api/auth 接口契约",
      artifacts: ["docs/01-prd.md"],
      note: "验收标准: 401/403 区分",
    });
    // 正文存在且用 STAGE- 前缀（与 ADR 的 NNNN- 和 DECL- 区分）
    assert.ok(existsSync(path), "正文文件应被创建");
    const fileName = path.split(/[\\/]/).pop();
    assert.match(fileName, /^STAGE-1-/, "阶段声明文件名用 STAGE-<n>- 前缀");
    // 结构化 frontmatter（供 dashboard 解析）
    const body = await readFile(path, "utf8");
    assert.match(body, /type: stage/, "正文含 type: stage frontmatter");
    assert.match(body, /stage: 1/, "正文含 stage frontmatter");
    assert.match(body, /task: /, "正文含 task frontmatter");
    // map 索引行用 STAGE 前缀标记（与 ADR/DECL 行视觉区分）
    // TD-91：STAGE/DECL 索引在 pipeline/map.md（不在 decisions/map.md）
    const map = await readFile(join(waoDir, "pipeline", "map.md"), "utf8");
    assert.match(map, /^STAGE \| 1 \|/m, "map 含 STAGE 索引行（含阶段号）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-83: stage 枚举校验——非法 stage 抛错（防跳号逃避 pipeline 门控）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    // 合法枚举值都能写入
    for (const stage of STAGE_NUMBERS) {
      await addStage(waoDir, { stage, task: `阶段 ${stage}` });
    }
    const stages = await listStages(waoDir);
    assert.equal(stages.length, STAGE_NUMBERS.length, "每个合法 stage 各写一条");
    // 非法 stage 抛错（0/7/字符串/负数）
    for (const bad of [0, 7, -1, "1.5", "x"]) {
      await assert.rejects(
        () => addStage(waoDir, { stage: bad, task: "x" }),
        /stage 必须是/,
        `非法 stage ${bad} 必须被拒（防跳号/自造阶段）`
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-83: 空 task 抛错（task 是可见性的核心，不能空）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await assert.rejects(
      () => addStage(waoDir, { stage: 1, task: "   " }),
      /task 不能为空/,
      "空 task 必须被拒"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-83: listStages 从 map 读回阶段声明（不读正文）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await addStage(waoDir, { stage: 1, task: "理解任务", artifacts: ["docs/spec.md"] });
    await addStage(waoDir, { stage: 3, task: "派发实现", artifacts: ["runs/run_xxx.jsonl"] });
    const stages = await listStages(waoDir);
    assert.equal(stages.length, 2, "列出 2 条阶段声明");
    assert.ok(stages.some((s) => s.stage === 1 && s.task.includes("理解")), "含阶段 1 声明");
    assert.ok(stages.some((s) => s.stage === 3), "含阶段 3 声明");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-83: summarizeStages 聚合 declared 集合（供 dashboard 渲染阶段缺口）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    // Lead 只走了阶段 1 和 3（跳了 2/4/5/6——典型"敷衍"模式）
    await addStage(waoDir, { stage: 1, task: "spec" });
    await addStage(waoDir, { stage: 3, task: "派工" });
    const summary = await summarizeStages(waoDir);
    assert.equal(summary.count, 2, "声明 2 个阶段");
    assert.ok(summary.declared.has(1), "阶段 1 已声明");
    assert.ok(summary.declared.has(3), "阶段 3 已声明");
    assert.ok(!summary.declared.has(2), "阶段 2 缺口（未声明）——dashboard 应显示 —");
    assert.ok(!summary.declared.has(6), "阶段 6 缺口（未声明）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-83/TD-91: STAGE-/DECL- 在 pipeline/，ADR 在 decisions/，三者独立不混", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    // TD-91：ADR 进 decisions/，STAGE/DECL 进 pipeline/——不再混在一个目录
    const { addDecision } = await import("../src/waoDecisions.js");
    const { addDeclare } = await import("../src/waoDeclare.js");
    await addDecision(waoDir, { title: "架构决策", body: "b" });
    await addDeclare(waoDir, { task: "自做声明", reason: "too-small" });
    await addStage(waoDir, { stage: 1, task: "阶段声明" });
    await addDecision(waoDir, { title: "第二条决策", body: "b2" });
    // decisions/ 只应有 ADR（NNNN-），不应有 STAGE-/DECL-
    const decisionsFiles = readdirSync(join(waoDir, "decisions")).filter((f) => f.endsWith(".md") && f !== "map.md");
    const adrFiles = decisionsFiles.filter((f) => /^\d{4}-/.test(f));
    assert.equal(adrFiles.length, 2, "decisions/ 有 2 个 ADR");
    assert.equal(decisionsFiles.filter((f) => /^STAGE-|^DECL-/.test(f)).length, 0,
      "decisions/ 不应有 STAGE-/DECL-（TD-91 已挪到 pipeline/）");
    // pipeline/ 应有 STAGE- + DECL-
    const pipelineFiles = readdirSync(join(waoDir, "pipeline")).filter((f) => f.endsWith(".md") && f !== "map.md");
    assert.equal(pipelineFiles.filter((f) => f.startsWith("DECL-")).length, 1, "pipeline/ 有 1 个 DECL");
    assert.equal(pipelineFiles.filter((f) => f.startsWith("STAGE-")).length, 1, "pipeline/ 有 1 个 STAGE");
    // ADR 编号连续不受 STAGE/DECL 干扰
    assert.ok(adrFiles.some((f) => f.startsWith("0001-")), "ADR 0001 存在");
    assert.ok(adrFiles.some((f) => f.startsWith("0002-")), "ADR 0002 存在（编号未被打断）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
