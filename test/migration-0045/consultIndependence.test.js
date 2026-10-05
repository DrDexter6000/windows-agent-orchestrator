// test/migration-0045/consultIndependence.test.js
//
// 0045 W3d（R4 裁定）：会审独立性三枚举纯函数 + 渲染不对称措辞。
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveIndependenceRelations } from "../../src/application/consultService.js";
import { renderCouncilDiffText } from "../../src/commands/consult.js";

test("IND-1: 同车道分组（等价类编号、首现顺序）；缺事实=null/unknown 不折叠为 false", () => {
  const r = deriveIndependenceRelations({
    seatFacts: [
      { agentId: "a", runId: "r1", laneFingerprint: "lane:" + "aa".repeat(8), modelId: "m1" },
      { agentId: "b", runId: "r2", laneFingerprint: "lane:" + "aa".repeat(8), modelId: "m1" },
      { agentId: "c", runId: "r3", laneFingerprint: "lane:" + "bb".repeat(8), modelId: "m2" },
      { agentId: "d", runId: "r4" },
    ],
    authorFacts: { laneFingerprint: "lane:" + "bb".repeat(8), modelId: "m2" },
  });
  assert.equal(r.seats[0].laneGroup, 1);
  assert.equal(r.seats[1].laneGroup, 1, "同车道同组");
  assert.equal(r.seats[2].laneGroup, 2);
  assert.equal(r.seats[3].laneGroup, null, "缺事实=null（不猜）");
  assert.equal(r.seats[0].authorRelation, "different_lane");
  assert.equal(r.seats[2].authorRelation, "same_lane");
  assert.equal(r.seats[3].authorRelation, "unknown", "缺事实=unknown≠false");
  assert.equal(r.seats[2].modelRelation, "same_model");
  assert.equal(r.seats[0].modelRelation, "different_model");
  assert.equal(r.seats.every((x) => x.providerSessionRelation === "unknown"), true, "会话关联如实 unknown");
  assert.equal(r.authorLaneInSeats, true, "作者同源=至少一席同车道");
});

test("IND-2: 无被审作者 → authorLaneInSeats=null（不可判定不猜）", () => {
  const r = deriveIndependenceRelations({ seatFacts: [{ agentId: "a", runId: "r1", laneFingerprint: "lane:" + "aa".repeat(8) }] });
  assert.equal(r.authorLaneInSeats, null);
  assert.equal(r.seats[0].authorRelation, "unknown");
});

test("IND-3: 渲染不对称措辞——同源=黄牌断言；不等=只说未检出永不称独立", () => {
  const text = renderCouncilDiffText({
    consultId: "consult_test_ind3",
    record: { consultId: "consult_test_ind3", brief: { path: null, sha256: "x" }, seats: [] },
    seats: [
      { agentId: "a", runId: "r1", runState: "completed", formatState: "unstructured", attribution: { ordered: [], unclassified: "x", preamble: "" }, laneGroup: 1, authorRelation: "same_lane", modelRelation: "same_model", providerSessionRelation: "unknown" },
      { agentId: "b", runId: "r2", runState: "completed", formatState: "unstructured", attribution: { ordered: [], unclassified: "y", preamble: "" }, laneGroup: 1, authorRelation: "same_lane", modelRelation: "same_model", providerSessionRelation: "unknown" },
      { agentId: "c", runId: "r3", runState: "completed", formatState: "unstructured", attribution: { ordered: [], unclassified: "z", preamble: "" }, laneGroup: 2, authorRelation: "different_lane", modelRelation: "different_model", providerSessionRelation: "unknown" },
    ],
    fieldDiff: [], questions: [],
    bricks: { reviewedRunId: "run_x", authorInSeats: false, authorLaneInSeats: true, reviewedAgentId: "someone" },
  });
  assert.match(text, /黄牌·同源席位：a、b 同车道（等价类 1）/);
  assert.match(text, /黄牌·作者同源：被审 run 与 a 同车道/);
  assert.ok(!/已证明独立|独立来源/.test(text), "永不宣称独立");
});
