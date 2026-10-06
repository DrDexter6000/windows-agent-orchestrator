// test/registry-roles/laneTraits.test.js
//
// 0046 §1/⑤：车道画像元数据守卫。
//   ① 结构：config/lane-traits.json 可解析，traits 键 ⊆ lanes.json 车道键（不要求
//      全覆盖——新车道可暂无画像），字段形状闭集（profile/suggestedUses/
//      contextWindow/multimodal/effortNote），来源标注必填（official/owner/wire）。
//   ② 隔离铁律（0046 §1.5 "特性字段不进派发/门禁文件"）：src/ 与 scripts/ 的
//      派发解析、门禁、runbook 执行路径**零引用** lane-traits（展示层除外——
//      目前无展示层消费方，即全仓 src/ 零引用；未来 Lead 读取面落地时本钉须
//      同步放宽为白名单）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const doc = JSON.parse(read("config/lane-traits.json"));
const lanes = JSON.parse(read("config/lanes.json"));
const laneIds = new Set(lanes.lanes.map((l) => l.id));
const SOURCE_TOKENS = ["official", "owner", "wire"];

test("0046 ⑤：lane-traits 结构——键⊆车道键、字段闭集、来源标注必填", () => {
  assert.equal(doc.schemaVersion, 1);
  const ids = Object.keys(doc.traits ?? {});
  assert.ok(ids.length >= 8, `应覆盖 ≥8 车道（实际 ${ids.length}）`);
  for (const id of ids) {
    assert.ok(laneIds.has(id), `traits 键 ${id} 不是 lanes.json 车道键`);
    const t = doc.traits[id];
    assert.equal(typeof t.profile, "string", `${id}.profile 必须是字符串`);
    assert.ok(Array.isArray(t.suggestedUses) && t.suggestedUses.length > 0, `${id}.suggestedUses 非空数组`);
    assert.ok(Number.isInteger(t.contextWindow?.tokens) && t.contextWindow?.tokens > 0, `${id}.contextWindow.tokens 正整数`);
    assert.ok(SOURCE_TOKENS.some((k) => (t.contextWindow?.source ?? "").includes(k)), `${id}.contextWindow.source 须含来源标注`);
    for (const k of ["image", "video"]) {
      assert.equal(typeof t.multimodal?.[k], "boolean", `${id}.multimodal.${k} 布尔`);
    }
    assert.ok(SOURCE_TOKENS.some((k) => (t.multimodal?.source ?? "").includes(k)), `${id}.multimodal.source 须含来源标注`);
  }
  // kimi 三态特记（0046 §2 Owner 实测修正）：256K/仅图/effortNote 在场。
  assert.equal(doc.traits.kimi.contextWindow.tokens, 262144, "kimi=262144（Owner 钉正，非 1m）");
  assert.equal(doc.traits.kimi.multimodal.video, false, "kimi 无视频（视频需 kimi-for-coding 另车道）");
  assert.ok(/通道不表达/.test(doc.traits.kimi.effortNote ?? ""), "kimi effortNote=通道不表达");
});

test("0046 ⑤ 隔离铁律：src/ 派发与门禁路径零引用 lane-traits", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(name) && readFileSync(p, "utf8").includes("lane-traits")) {
        offenders.push(p.slice(ROOT.length + 1));
      }
    }
  };
  walk(join(ROOT, "src"));
  assert.deepEqual(offenders, [], "src/ 不得引用 lane-traits（画像=Lead 参考元数据，非派发/门禁输入；读取面落地时同步放宽本钉为白名单）");
});
