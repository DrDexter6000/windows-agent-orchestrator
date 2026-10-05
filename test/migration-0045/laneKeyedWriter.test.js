// test/migration-0045/laneKeyedWriter.test.js
//
// 0045 R5/W4a：认证写入器车道键化 + 门/详情双空间读取。
//   KEYW-1 同车道两席位→单条车道记录（agentIds provenance）+counts 不重复计。
//   KEYW-2 tri-state 严格键（undefined≠null 成分不同）。
//   KEYW-3 无身份事实的 legacy case→seat: 名键空间（读者仍可选）。
//   KEYW-4 门双空间：车道键台账上两席位 --require-certified 均命中同记录；legacy 席位键台账不回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCertification } from "../../scripts/reliability/certification.mjs";
import { laneLedgerKey } from "../../src/application/identityProjection.js";
import { selectCertRecord } from "../../src/runManager.js";

function mkCase(agentId, over = {}) {
  return {
    caseId: `case-${agentId}-${Math.random().toString(36).slice(2, 6)}`,
    agentId,
    backend: "zcode", providerID: null, modelId: "m-flash", providerKey: null,
    profile: "delta",
    lastHealthyRunAt: "2026-10-05T00:00:00.000Z",
    certification: { status: "conditional", capabilities: {} },
    checks: [],
    ...over,
  };
}

test("KEYW-1: 同车道两席位聚合成单条车道记录（provenance 保全），counts 计一次", () => {
  const summary = summarizeCertification([
    mkCase("researcher", { backend: "zcode", modelId: "m-flash", providerKey: null }),
    mkCase("coder_low", { backend: "zcode", modelId: "m-flash", providerKey: null }),
  ]);
  assert.equal(summary.ledgerKeySpace, "lane-v1");
  const keys = Object.keys(summary.workers);
  assert.equal(keys.length, 1, "两席位同指纹=一条车道记录");
  assert.match(keys[0], /^lane:[0-9a-f]{16}$/);
  const rec = summary.workers[keys[0]];
  assert.deepEqual([...rec.agentIds].sort(), ["coder_low", "researcher"], "席位名降为 provenance");
  assert.equal(rec.laneKey, keys[0]);
  assert.equal(summary.counts.conditional, 1, "counts 按车道计（两席位不重复）");
});

test("KEYW-2: tri-state 严格——providerKey undefined 与 null 是不同车道键", () => {
  const undefinedKey = laneLedgerKey({ backend: "zcode", modelId: "m", providerID: null, providerKey: undefined });
  const nullKey = laneLedgerKey({ backend: "zcode", modelId: "m", providerID: null, providerKey: null });
  assert.notEqual(undefinedKey, nullKey);
  assert.equal(undefinedKey, laneLedgerKey({ backend: "zcode", modelId: "m", providerID: null, providerKey: undefined }), "确定性");
  const summary = summarizeCertification([
    mkCase("a", { providerKey: undefined }),
    mkCase("b", { providerKey: null }),
  ]);
  assert.equal(Object.keys(summary.workers).length, 2, "tri-state 不同=不同车道记录");
});

test("KEYW-3: 无身份事实的 legacy case → seat: 名键（可被读者选出）", () => {
  const summary = summarizeCertification([
    mkCase("legacy_agg", { backend: undefined, providerID: undefined, modelId: undefined, providerKey: undefined }),
  ]);
  const keys = Object.keys(summary.workers);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], "seat:legacy_agg");
});

test("KEYW-4: selectCertRecord 双空间——席位键优先；车道键台账按事实选出", () => {
  const laneKey = laneLedgerKey({ backend: "zcode", modelId: "m-flash", providerID: null, providerKey: null });
  const laneLedger = {
    ledgerKeySpace: "lane-v1",
    workers: {
      [laneKey]: { agentId: "coder_low", agentIds: ["researcher", "coder_low"], laneKey, backend: "zcode", modelId: "m-flash", providerID: null, providerKey: null, status: "conditional" },
      "lane:ffffffffffffffff": { agentId: "other", backend: "codex", modelId: "m-sol", providerID: null, providerKey: null, status: "certified" },
    },
  };
  const agentFlash = { backend: "zcode", model: { id: "m-flash" }, provider: undefined };
  const rec = selectCertRecord(laneLedger, agentFlash, "researcher");
  assert.equal(rec?.laneKey, laneKey, "车道键台账：席位名查不到→按事实选出正确车道记录");
  // legacy 席位键台账：精确命中不回归
  const legacyLedger = { workers: { researcher: { agentId: "researcher", backend: "zcode", modelId: "m-flash", providerID: null, providerKey: null, status: "conditional" } } };
  const rec2 = selectCertRecord(legacyLedger, agentFlash, "researcher");
  assert.equal(rec2?.agentId, "researcher", "legacy 台账：席位键精确命中");
  // 空台账/无匹配 → undefined（门按未认证拒）
  assert.equal(selectCertRecord({ workers: {} }, agentFlash, "researcher"), undefined);
});
