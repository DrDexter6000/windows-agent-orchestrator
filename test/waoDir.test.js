import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWaoDir, validateWaoDir, getWaoDir, WAO_TOP_LEVEL_SLOTS } from "../src/waoDir.js";

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "wao-dir-"));
}

test("S3-1: initWaoDir 创建 6 槽位 + 各 map.md（TD-91 加 pipeline）", async () => {
  const dir = await makeTempDir();
  try {
    await initWaoDir(dir);
    // 6 个顶层槽位都存在
    assert.ok(existsSync(join(dir, ".wao", "project.md")), "project.md 应存在");
    assert.ok(existsSync(join(dir, ".wao", "state")), "state/ 应存在");
    assert.ok(existsSync(join(dir, ".wao", "decisions")), "decisions/ 应存在");
    assert.ok(existsSync(join(dir, ".wao", "pipeline")), "pipeline/ 应存在（TD-91）");
    assert.ok(existsSync(join(dir, ".wao", "handoff")), "handoff/ 应存在");
    assert.ok(existsSync(join(dir, ".wao", "runs")), "runs/ 应存在");
    // 各 map.md 存在（state/decisions/pipeline/handoff 有 map，project.md 是单文件，runs 无 map）
    assert.ok(existsSync(join(dir, ".wao", "state", "map.md")), "state/map.md 应存在");
    assert.ok(existsSync(join(dir, ".wao", "decisions", "map.md")), "decisions/map.md 应存在");
    assert.ok(existsSync(join(dir, ".wao", "pipeline", "map.md")), "pipeline/map.md 应存在（TD-91）");
    assert.ok(existsSync(join(dir, ".wao", "handoff", "map.md")), "handoff/map.md 应存在");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-1: initWaoDir 幂等（重复 init 不破坏已有内容）", async () => {
  const dir = await makeTempDir();
  try {
    await initWaoDir(dir);
    // 写一条已有内容（模拟用户已用了）
    await writeFile(join(dir, ".wao", "decisions", "0001-test.md"), "existing decision");
    await writeFile(join(dir, ".wao", "decisions", "map.md"), "0001 | test | existing\n");
    // 重复 init
    await initWaoDir(dir);
    // 已有内容不丢
    const content = await readFile(join(dir, ".wao", "decisions", "0001-test.md"), "utf8");
    assert.equal(content, "existing decision", "重复 init 不应破坏已有决策");
    const map = await readFile(join(dir, ".wao", "decisions", "map.md"), "utf8");
    assert.ok(map.includes("0001 | test"), "重复 init 不应清空已有 map");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-1: initWaoDir 追加 .wao/ 到 .gitignore（不重复追加）", async () => {
  const dir = await makeTempDir();
  try {
    // 首次 init
    await initWaoDir(dir);
    let gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    assert.ok(gitignore.includes(".wao/"), "首次 init 应追加 .wao/ 到 .gitignore");
    // 重复 init
    await initWaoDir(dir);
    gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    const matches = gitignore.match(/\.wao\//g) ?? [];
    assert.equal(matches.length, 1, "重复 init 不应重复追加 .wao/");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-1: validateWaoDir 检测缺失槽位 + 多余文件", async () => {
  const dir = await makeTempDir();
  try {
    // 合法 init
    await initWaoDir(dir);
    let result = validateWaoDir(dir);
    assert.ok(result.ok, "合法 init 后 validate 应 ok");
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unexpected, []);

    // 加一个非法文件
    await writeFile(join(dir, ".wao", "rogue-doc.md"), "should not be here");
    result = validateWaoDir(dir);
    assert.ok(!result.ok, "有多余文件应不 ok");
    assert.ok(result.unexpected.includes("rogue-doc.md"), "应报出非法文件");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-1: validateWaoDir 对未 init 的目录返回 not initialized", async () => {
  const dir = await makeTempDir();
  try {
    const result = validateWaoDir(dir);
    assert.ok(!result.ok, "未 init 应不 ok");
    assert.equal(result.initialized, false, "应标 initialized=false");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-1: getWaoDir 支持 --state-dir 覆盖", () => {
  // 默认 .wao（用 endsWith 避免跨平台盘符/分隔符差异）
  assert.ok(getWaoDir("proj", undefined).endsWith(join(".wao")) || getWaoDir("proj", undefined).endsWith(".wao"));
  // 覆盖
  const custom = getWaoDir("proj", ".custom-wao");
  assert.ok(custom.endsWith(".custom-wao"), `应支持覆盖，got ${custom}`);
});

test("S3-1: WAO_TOP_LEVEL_SLOTS 导出预定义 6 槽位（TD-91 加 pipeline）", () => {
  assert.ok(Array.isArray(WAO_TOP_LEVEL_SLOTS));
  assert.ok(WAO_TOP_LEVEL_SLOTS.length === 6, "应正好 6 个槽位（TD-91 加 pipeline）");
  for (const slot of ["project.md", "state", "decisions", "pipeline", "handoff", "runs"]) {
    assert.ok(WAO_TOP_LEVEL_SLOTS.includes(slot), `应含 ${slot}`);
  }
});
