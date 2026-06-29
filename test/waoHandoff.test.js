import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWaoDir, getWaoDir } from "../src/waoDir.js";
import { writeHandoff, readHandoff } from "../src/waoHandoff.js";

async function makeInitWao() {
  const dir = await mkdtemp(join(tmpdir(), "wao-ho-"));
  await initWaoDir(dir);
  return dir;
}

test("S3-4: writeHandoff 建交接卡 + 更新 map", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    const path = await writeHandoff(waoDir, {
      from: "lead",
      to: "coder",
      summary: "Refactor auth.js to async/await",
      artifacts: ["runs/run_xxx.jsonl", ".wao/state/current.md"],
      claims: [{ field: "affectedFiles", value: "src/auth.js" }],
    });
    assert.ok(existsSync(path), "交接卡应被创建");
    const body = await readFile(path, "utf8");
    assert.match(body, /lead.*coder|coder.*lead/, "含 from→to");
    assert.match(body, /Refactor auth/, "含 summary");
    assert.match(body, /run_xxx\.jsonl/, "含 artifact 引用");
    assert.match(body, /affectedFiles/, "含 claim");
    // map 更新
    const map = await readFile(join(waoDir, "handoff", "map.md"), "utf8");
    assert.match(map, /lead.*coder/, "map 含交接索引");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-4: readHandoff 读发给该 role 的最新交接卡（按日期排序）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    // 写两张（同 role，不同时间——用不同 summary 模拟）
    await writeHandoff(waoDir, { from: "lead", to: "coder", summary: "first task" });
    // 稍等确保时间戳不同
    await new Promise((r) => setTimeout(r, 1100));
    await writeHandoff(waoDir, { from: "lead", to: "coder", summary: "second task" });
    const latest = await readHandoff(waoDir, "coder");
    assert.ok(latest, "应读到交接卡");
    assert.match(latest, /second task/, "应读最新（second），不是 first");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-57: readHandoff(role) 读取发给 role 的 incoming，不读该 role 发出的 outgoing", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await writeHandoff(waoDir, { from: "lead", to: "coder_low", summary: "lead outgoing should not be read by lead" });
    await new Promise((r) => setTimeout(r, 1100));
    await writeHandoff(waoDir, { from: "coder_low", to: "lead", summary: "first incoming to lead" });
    await new Promise((r) => setTimeout(r, 1100));
    await writeHandoff(waoDir, { from: "tester", to: "lead", summary: "latest incoming to lead" });

    const latest = await readHandoff(waoDir, "lead");
    assert.ok(latest, "lead 应读到 incoming handoff");
    assert.match(latest, /latest incoming to lead/, "应返回发给 lead 的最新 incoming");
    assert.doesNotMatch(latest, /lead outgoing should not be read by lead/, "不得返回 lead 自己发出的 outgoing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
