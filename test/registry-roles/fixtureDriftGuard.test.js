// test/registry-roles/fixtureDriftGuard.test.js
//
// TD-214 漂移机器看守（2026-10-06 双席会审裁定 B 的补强）：test/fixtures/
// lanes-agents.fixture.json（确定性套件的注册表权威）与 config/lanes.json +
// config/agents.example.json（tracked 车道权威）之间的**结构性投影**一致性——
// 只比键名集合与车道键集合，绝不比值（值漂移属正常演化，键缺失=测试面盲区）。
// 当日交付验证假红根因=fixture 与基线漂移无人看守；本钉把"fixture 维护义务"
// 从人的记忆变成机器。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

test("TD-214 看守①: fixture 车道键集合 ≡ lanes.json 车道键集合（键级，值不比）", () => {
  const fixture = read("test/fixtures/lanes-agents.fixture.json");
  const lanes = read("config/lanes.json");
  const fixtureIds = new Set(Object.keys(fixture.agents ?? {}));
  const laneIds = new Set((lanes.lanes ?? []).map((l) => l.id));
  const missingInFixture = [...laneIds].filter((id) => !fixtureIds.has(id));
  const extraInFixture = [...fixtureIds].filter((id) => !laneIds.has(id));
  assert.deepEqual(
    { missingInFixture, extraInFixture },
    { missingInFixture: [], extraInFixture: [] },
    "fixture 与 lanes.json 的车道键集合漂移——新车道必须同步进 fixture（键级），否则确定性套件对其盲",
  );
});

test("TD-214 看守②: fixture 条目 schema 形状 ⊆ 合法字段闭集（结构投影，不比值）", () => {
  const fixture = read("test/fixtures/lanes-agents.fixture.json");
  const LEGAL = new Set(["backend", "model", "reasoning", "cwd", "env", "binary",
    "serveUrl", "tokenEnv", "credentialEnv", "seatRole", "args", "_comment"]);
  for (const [id, entry] of Object.entries(fixture.agents ?? {})) {
    for (const key of Object.keys(entry)) {
      assert.ok(LEGAL.has(key), `fixture.${id} 出现未登记字段 "${key}"——先扩 LEGAL 闭集（有意为之）再使用`);
    }
    assert.equal(typeof entry.backend, "string", `fixture.${id}.backend 必填字符串`);
  }
});

test("TD-214 看守③: example 模板 env 块键名集合与 fixture 一致（承重变量桥的键级对齐）", () => {
  const example = read("config/agents.example.json");
  const fixture = read("test/fixtures/lanes-agents.fixture.json");
  const envKeysOf = (doc) => {
    const out = new Set();
    for (const entry of Object.values(doc.agents ?? {})) {
      for (const k of Object.keys(entry.env ?? {})) out.add(k);
    }
    return out;
  };
  const ex = envKeysOf(example);
  const fx = envKeysOf(fixture);
  // example 允许比 fixture 多（模板展示面）；不允许 fixture 多出 example 未登记的
  // 键（测试面使用模板未声明的承重变量=盲区）。
  const extraInFixture = [...fx].filter((k) => !ex.has(k));
  assert.deepEqual(extraInFixture, [], `fixture env 键 ${extraInFixture} 未在 example 模板登记——承重变量桥应对齐`);
});
