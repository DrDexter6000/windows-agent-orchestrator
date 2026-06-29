import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWaoDir, getWaoDir } from "../src/waoDir.js";
import { addDecision, listDecisions, readDecision } from "../src/waoDecisions.js";

async function makeInitWao() {
  const dir = await mkdtemp(join(tmpdir(), "wao-dec-"));
  await initWaoDir(dir);
  return dir;
}

test("S3-3: addDecision 建正文 + 更新 map（原子，一次调用两件事）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    const path = await addDecision(waoDir, {
      title: "Use kimi-code CLI for Kimi",
      body: "Kimi via kimi-code CLI instead of opencode, to avoid stop risk.",
      context: "06-18 incident showed opencode stop is unreliable",
    });
    // 正文存在
    assert.ok(existsSync(path), "正文文件应被创建");
    const body = await readFile(path, "utf8");
    assert.match(body, /Use kimi-code CLI/, "正文含标题");
    assert.match(body, /avoid stop risk/, "正文含 body");
    // map 也更新了（索引行）
    const map = await readFile(join(waoDir, "decisions", "map.md"), "utf8");
    assert.match(map, /0001/, "map 含编号 0001");
    assert.match(map, /kimi-code/, "map 含标题关键词");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-3: 序列号自增（0001→0002，不重号）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    const p1 = await addDecision(waoDir, { title: "first", body: "b1" });
    const p2 = await addDecision(waoDir, { title: "second", body: "b2" });
    assert.ok(p1.includes("0001"), "第一条是 0001");
    assert.ok(p2.includes("0002"), "第二条是 0002");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-3: map.md 索引行格式（编号 | 标题 | 一句话）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await addDecision(waoDir, { title: "Test Decision", body: "x" });
    const map = await readFile(join(waoDir, "decisions", "map.md"), "utf8");
    // 找到非注释、非标题的索引行
    const indexLines = map.split("\n").filter((l) => /^\d{4}\s*\|/.test(l));
    assert.ok(indexLines.length >= 1, "应有编号开头的索引行");
    assert.match(indexLines[0], /0001.*\|/, "格式：编号 | 标题 | ...");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-3: listDecisions 从 map 读（不扫正文，渐进式披露）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await addDecision(waoDir, { title: "Alpha", body: "a body" });
    await addDecision(waoDir, { title: "Beta", body: "b body" });
    const list = await listDecisions(waoDir);
    assert.equal(list.length, 2);
    assert.match(list[0], /0001/, "第一条 0001");
    assert.match(list[1], /0002/, "第二条 0002");
    // list 不含正文（只有索引行）
    for (const line of list) {
      assert.ok(!line.includes("a body") && !line.includes("b body"), "list 不应含正文");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-3: readDecision 读单个正文", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await addDecision(waoDir, { title: "Readable", body: "full body text here" });
    const body = await readDecision(waoDir, "0001");
    assert.match(body, /Readable/, "含标题");
    assert.match(body, /full body text/, "含正文");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
