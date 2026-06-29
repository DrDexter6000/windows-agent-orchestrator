import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWaoDir, getWaoDir, WAO_TOP_LEVEL_SLOTS } from "../src/waoDir.js";
import { addDecision } from "../src/waoDecisions.js";

async function makeInitWao() {
  const dir = await mkdtemp(join(tmpdir(), "wao-layout-"));
  await initWaoDir(dir);
  return dir;
}

/**
 * 守卫1（导出供复用）：.wao/ 顶层只有预定义 5 槽位。
 * 这是治文档熵增的核心：负向断言"不准新建文档类型"。
 * 任何 agent 想往 .wao/ 塞 docs/my-finding.md，这里会抓。
 */
export function assertWaoTopLevelClean(waoDir) {
  assert.ok(existsSync(waoDir), ".wao/ 必须存在");
  const actual = readdirSync(waoDir);
  const allowed = new Set(WAO_TOP_LEVEL_SLOTS);
  const unexpected = actual.filter((e) => !allowed.has(e));
  assert.deepEqual(unexpected, [],
    `.wao/ 出现未授权顶层条目 ${JSON.stringify(unexpected)}；只允许 ${[...allowed].join(", ")}`);
}

/**
 * 守卫2（导出供复用）：decisions/map.md 每行索引对应实际存在的正文文件，
 * 且每个正文文件都在 map 里有索引。双向一致。
 */
export async function assertDecisionsMapConsistency(waoDir) {
  const decisionsDir = join(waoDir, "decisions");
  const mapPath = join(decisionsDir, "map.md");
  let map = "";
  try { map = await readFile(mapPath, "utf8"); } catch { return; }
  // map 里的编号
  const mapIds = new Set(
    map.split("\n").filter((l) => /^\d{4}\s*\|/.test(l)).map((l) => l.slice(0, 4)),
  );
  // 实际正文文件
  const files = readdirSync(decisionsDir).filter((f) => /^\d{4}-.*\.md$/.test(f));
  const fileIds = new Set(files.map((f) => f.slice(0, 4)));
  // 正文存在但 map 没索引
  for (const id of fileIds) {
    assert.ok(mapIds.has(id), `decisions 正文 ${id} 存在但 map.md 无索引（脱节）`);
  }
  // map 有索引但正文不存在
  for (const id of mapIds) {
    assert.ok(fileIds.has(id), `decisions map 索引 ${id} 但正文文件不存在（悬空索引）`);
  }
}

test("S3-5 守卫1: tmpdir 合法 .wao/ → assertWaoTopLevelClean 通过", async () => {
  const dir = await makeInitWao();
  try {
    assertWaoTopLevelClean(getWaoDir(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-5 守卫1: tmpdir .wao/ 加非法文件 → 断言失败报未授权条目", async () => {
  const dir = await makeInitWao();
  try {
    await writeFile(join(getWaoDir(dir), "rogue-doc.md"), "should not be here");
    assert.throws(
      () => assertWaoTopLevelClean(getWaoDir(dir)),
      /rogue-doc/,
      "应有非法文件报错，并指出文件名",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-5 守卫2: decisions 正文与 map 双向一致 → 通过", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await addDecision(waoDir, { title: "first", body: "b1" });
    await addDecision(waoDir, { title: "second", body: "b2" });
    await assertDecisionsMapConsistency(waoDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-5 守卫2: 正文存在但 map 没索引 → 断言失败（脱节）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    // 建一个正文但不更新 map（模拟 agent 绕过命令直接写文件）
    await writeFile(join(waoDir, "decisions", "0099-rogue.md"), "# 0099: rogue\n");
    await assert.rejects(
      () => assertDecisionsMapConsistency(waoDir),
      /0099.*map.*无索引|0099.*脱节/,
      "正文存在但 map 无索引应报脱节",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-5 守卫2: map 有索引但正文不存在 → 断言失败（悬空）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    // map 加一行假索引，但没建正文
    const mapPath = join(waoDir, "decisions", "map.md");
    await writeFile(mapPath, "0088 | ghost | does not exist\n", { flag: "a" });
    await assert.rejects(
      () => assertDecisionsMapConsistency(waoDir),
      /0088.*正文.*不存在|0088.*悬空/,
      "map 索引但正文不存在应报悬空",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 真实项目守卫：WAO 项目自己的 .wao/（dogfooding 场景）。
// 若 .wao/ 不存在则跳过（不强求每个环境都 init）；存在则守结构 + decisions 一致性。
test("S3-5 真实守卫: WAO 项目自身 .wao/ 结构干净 + decisions 一致", async () => {
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const waoDir = getWaoDir(projectRoot);
  if (!existsSync(waoDir)) {
    // .wao/ 未 init，跳过（不强制）
    return;
  }
  assertWaoTopLevelClean(waoDir);
  await assertDecisionsMapConsistency(waoDir);
});

// ---------------------------------------------------------------------------
// R3 角色契约纪律守卫（2026-06-24）
//
// WAO 第一原则：绝不往 worker system prompt 灌编排逻辑。
// 角色 prompt（config/roles/*.md）只能含 identity/scope/纪律，不能含调度决策。
// 此测试扫描所有角色文件，发现编排关键词即失败——防止以后有人往角色 prompt 塞编排。
// ---------------------------------------------------------------------------

test("R3 纪律: config/roles/*.md 不含编排逻辑关键词", async () => {
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const rolesDir = join(projectRoot, "config", "roles");
  if (!existsSync(rolesDir)) return; // 无 roles 目录则跳过
  const files = readdirSync(rolesDir).filter((f) => f.endsWith(".md"));
  // 编排逻辑关键词（出现即说明角色 prompt 越界，塞了调度决策）
  const ORCHESTRATION_PATTERNS = [
    /如果.*失败.*(重试|通知|转派|路由)/,
    /重试\s*\d+\s*次/,
    /通知\s*(lead|主控|下游|上游)/,
    /路由到|调度到|派发给/,
    /状态机|gate.*通过.*才/,
  ];
  for (const file of files) {
    const content = readFileSync(join(rolesDir, file), "utf8");
    for (const pattern of ORCHESTRATION_PATTERNS) {
      assert.ok(
        !pattern.test(content),
        `${file} 含编排逻辑关键词 ${pattern}（角色 prompt 禁编排，只允许 identity/scope/纪律）`,
      );
    }
  }
});
