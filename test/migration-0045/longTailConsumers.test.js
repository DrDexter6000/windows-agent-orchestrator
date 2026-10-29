// test/migration-0045/longTailConsumers.test.js
//
// 0045 W4c（R5 点名三处旁路）：
//   WF-1 workflow agentHandler 经解析层——已随决定 0094（workflow 层退役）删除。
//   CR-2 会审厂族砖：注册表解析失败如实标注（渲染区分"席位不在册"与"确无 provider"）。
//   PR-3 seatRoleOf 按角色事实分类——0065 随 seatRoleOf 宿主删除（TD-263 随关）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCouncilDiffText } from "../../src/commands/consult.js";


test("CR-2: 厂族砖渲染——解析失败/注册表不可读如实标注（不混入'确无 provider'）", () => {
  const text = renderCouncilDiffText({
    consultId: "consult_test_cr2",
    record: { consultId: "consult_test_cr2", brief: { path: null, sha256: "x" }, seats: [] },
    seats: [
      { agentId: "alive", runId: "r1", runState: "completed", formatState: "unstructured", backend: "codex", provider: null, registryResolution: "ok", attribution: { ordered: [], unclassified: "x", preamble: "" } },
      { agentId: "gone_seat", runId: "r2", runState: "completed", formatState: "unstructured", backend: null, provider: null, registryResolution: "failed", attribution: { ordered: [], unclassified: "y", preamble: "" } },
      { agentId: "noreg", runId: "r3", runState: "completed", formatState: "unstructured", backend: null, provider: null, registryResolution: "registry-unreadable", attribution: { ordered: [], unclassified: "z", preamble: "" } },
    ],
    fieldDiff: [], questions: [],
    bricks: {},
  });
  assert.match(text, /alive=codex @ 无 provider 标识/);
  assert.match(text, /gone_seat=注册表解析失败（席位已不在注册表？不按独立计）/);
  assert.match(text, /noreg=注册表不可读（不按独立计）/);
});

