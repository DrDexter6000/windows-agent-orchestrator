// TD-102 最终收尾: buildWorkflowNodeSummary 纯函数契约测试。
//
// 验证 CLI node summary 的三类节点渲染：
// - 有 nodeResult: {completed, runId}
// - skipped: {completed:false, skipped:true}
// - 其它未执行（timeout 截断）: {completed:false, skipped:false, notExecuted:true}
//
// 纯函数测试，不需要真实模型/引擎。
import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowNodeSummary } from "../../src/commands/workflow.js";

function mockEffectiveDef(ids) {
  return { nodes: ids.map((id) => ({ id })) };
}

test("TD-102: buildWorkflowNodeSummary — 有结果的节点输出 {completed, runId}", () => {
  const def = mockEffectiveDef(["a", "b", "c"]);
  const result = {
    nodeResults: { a: { completed: true, runId: "run_1" } },
    skipped: ["c"],
  };
  const nodes = buildWorkflowNodeSummary(def, result);
  assert.deepEqual(nodes.a, { completed: true, runId: "run_1" });
});

test("TD-102: buildWorkflowNodeSummary — skipped 节点输出 {completed:false, skipped:true}", () => {
  const def = mockEffectiveDef(["a", "b", "c"]);
  const result = {
    nodeResults: { a: { completed: true, runId: "run_1" } },
    skipped: ["c"],
  };
  const nodes = buildWorkflowNodeSummary(def, result);
  assert.deepEqual(nodes.c, { completed: false, skipped: true });
});

test("TD-102: buildWorkflowNodeSummary — 未执行节点输出 {completed:false, skipped:false, notExecuted:true}", () => {
  const def = mockEffectiveDef(["a", "b", "c"]);
  const result = {
    nodeResults: { a: { completed: true, runId: "run_1" } },
    skipped: ["c"],
    // b 既不在 nodeResults 也不在 skipped（如 timeout 截断）
  };
  const nodes = buildWorkflowNodeSummary(def, result);
  assert.deepEqual(nodes.b, { completed: false, skipped: false, notExecuted: true });
});

test("TD-102: buildWorkflowNodeSummary — 输出键覆盖 effectiveDef 全部节点且顺序稳定", () => {
  const def = mockEffectiveDef(["a", "b", "c"]);
  const result = {
    nodeResults: { a: { completed: true, runId: "run_1" } },
    skipped: ["c"],
  };
  const nodes = buildWorkflowNodeSummary(def, result);
  assert.deepEqual(Object.keys(nodes), ["a", "b", "c"], "键顺序 = effectiveDef 定义顺序");
});

test("TD-102: buildWorkflowNodeSummary — 全 timeout 场景（无 nodeResults，无 skipped）", () => {
  const def = mockEffectiveDef(["a", "b"]);
  const result = { nodeResults: {}, skipped: [] };
  const nodes = buildWorkflowNodeSummary(def, result);
  assert.deepEqual(nodes.a, { completed: false, skipped: false, notExecuted: true });
  assert.deepEqual(nodes.b, { completed: false, skipped: false, notExecuted: true });
});
