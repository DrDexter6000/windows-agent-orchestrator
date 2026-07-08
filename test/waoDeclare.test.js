// waoDeclare.test.js
//
// TD-82：Lead 自做声明（declare）读写测试。声明让"Lead 自己做了一个本可派发的任务"
// 对用户/dashboard 可见——强制力是曝光不是拦截。
//
// 镜像 waoDecisions.test.js 的 idiom：临时 .wao/ + initWaoDir + addDeclare + 读回验证。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWaoDir, getWaoDir } from "../src/waoDir.js";
import { addDeclare, listDeclares, summarizeDeclares, REASON_CODES } from "../src/waoDeclare.js";

async function makeInitWao() {
  const dir = await mkdtemp(join(tmpdir(), "wao-decl-"));
  await initWaoDir(dir);
  return dir;
}

test("TD-82: addDeclare 建正文(DECL- 前缀 + 结构化 frontmatter) + 更新 map", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    const path = await addDeclare(waoDir, {
      task: "改了 cli.js 的 help 文本",
      reason: "too-small",
      note: "改两行，派工开销不值",
    });
    // 正文存在且用 DECL- 前缀（与 ADR 的 NNNN- 区分）
    assert.ok(existsSync(path), "正文文件应被创建");
    const fileName = path.split(/[\\/]/).pop();
    assert.match(fileName, /^DECL-/, "声明文件名用 DECL- 前缀");
    // 结构化 frontmatter（供 dashboard 解析）
    const body = await readFile(path, "utf8");
    assert.match(body, /type: declare/, "正文含 type: declare frontmatter");
    assert.match(body, /reason: too-small/, "正文含 reason frontmatter");
    assert.match(body, /task: /, "正文含 task frontmatter");
    // map 索引行用 DECL 前缀标记（与 ADR 行视觉区分）
    // TD-91：DECL 索引在 pipeline/map.md（不在 decisions/map.md）
    const map = await readFile(join(waoDir, "pipeline", "map.md"), "utf8");
    assert.match(map, /^DECL \|.*too-small/m, "map 含 DECL 索引行（含 reason）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-82: reason 枚举校验——非法 reason 抛错（防自由文本逃避约束）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    // 合法枚举值都能写入
    for (const reason of REASON_CODES) {
      await addDeclare(waoDir, { task: `测试 ${reason}`, reason });
    }
    const declares = await listDeclares(waoDir);
    assert.equal(declares.length, REASON_CODES.length, "每个合法 reason 各写一条");
    // 非法 reason 抛错
    await assert.rejects(
      () => addDeclare(waoDir, { task: "x", reason: "因为我觉得快一点" }),
      /reason 必须是枚举值/,
      "自由文本 reason 必须被拒（防声明退化）"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-82: 空 task 抛错（task 是可见性的核心，不能空）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await assert.rejects(
      () => addDeclare(waoDir, { task: "   ", reason: "too-small" }),
      /task 不能为空/,
      "空 task 必须被拒"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-82: listDeclares 从 map 读回声明（不读正文）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await addDeclare(waoDir, { task: "任务甲", reason: "too-coupled" });
    await addDeclare(waoDir, { task: "任务乙", reason: "verification-cheaper" });
    const declares = await listDeclares(waoDir);
    assert.equal(declares.length, 2, "列出 2 条声明");
    assert.ok(declares.some((d) => d.reason === "too-coupled"), "含 too-coupled 声明");
    assert.ok(declares.some((d) => d.reason === "verification-cheaper"), "含 verification-cheaper 声明");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-82: summarizeDeclares 聚合 count + byReason（供 dashboard）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await addDeclare(waoDir, { task: "a", reason: "too-small" });
    await addDeclare(waoDir, { task: "b", reason: "too-small" });
    await addDeclare(waoDir, { task: "c", reason: "too-coupled" });
    const summary = await summarizeDeclares(waoDir);
    assert.equal(summary.count, 3, "总数 3");
    assert.equal(summary.byReason["too-small"], 2, "too-small ×2");
    assert.equal(summary.byReason["too-coupled"], 1, "too-coupled ×1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-82/TD-91: DECL- 在 pipeline/，ADR 在 decisions/，编号独立不混", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    // TD-91：ADR 进 decisions/，DECL 进 pipeline/——不再混在一个目录
    const { addDecision } = await import("../src/waoDecisions.js");
    await addDecision(waoDir, { title: "架构决策", body: "b" });
    await addDeclare(waoDir, { task: "自做声明", reason: "too-small" });
    await addDecision(waoDir, { title: "第二条决策", body: "b2" });
    // decisions/ 只应有 ADR
    const decisionsFiles = readdirSync(join(waoDir, "decisions")).filter((f) => f.endsWith(".md") && f !== "map.md");
    const adrFiles = decisionsFiles.filter((f) => /^\d{4}-/.test(f));
    assert.equal(adrFiles.length, 2, "decisions/ 有 2 个 ADR");
    assert.equal(decisionsFiles.filter((f) => f.startsWith("DECL-")).length, 0,
      "decisions/ 不应有 DECL-（TD-91 已挪到 pipeline/）");
    // pipeline/ 应有 DECL-
    const pipelineFiles = readdirSync(join(waoDir, "pipeline")).filter((f) => f.endsWith(".md") && f !== "map.md");
    assert.equal(pipelineFiles.filter((f) => f.startsWith("DECL-")).length, 1, "pipeline/ 有 1 个 DECL");
    // ADR 编号连续不受 DECL 干扰
    assert.ok(adrFiles.some((f) => f.startsWith("0001-")), "ADR 0001 存在");
    assert.ok(adrFiles.some((f) => f.startsWith("0002-")), "ADR 0002 存在（编号未被打断）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
