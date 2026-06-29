import test from "node:test";
import assert from "node:assert/strict";
import { defineWorkflow, validateWorkflow, topoSort } from "../../src/workflow/schema.js";

// 辅助：构造最小 workflow
function wf(nodes, edges) {
  return defineWorkflow({ id: "test", nodes, edges });
}

test("defineWorkflow: 合法 workflow 通过校验", () => {
  const def = wf(
    [{ id: "a", type: "agent", agentId: "x" }, { id: "b", type: "agent", agentId: "x" }],
    [{ from: "a", to: "b" }],
  );
  assert.equal(def.id, "test");
  assert.equal(def.nodes.length, 2);
});

test("defineWorkflow: 重复 node id 报错", () => {
  assert.throws(
    () => wf(
      [{ id: "a", type: "agent", agentId: "x" }, { id: "a", type: "agent", agentId: "x" }],
      [],
    ),
    /duplicate node id/i,
  );
});

test("defineWorkflow: 悬空 edge (引用不存在的 node) 报错", () => {
  assert.throws(
    () => wf(
      [{ id: "a", type: "agent", agentId: "x" }],
      [{ from: "a", to: "nonexistent" }],
    ),
    /references unknown node/i,
  );
  assert.throws(
    () => wf(
      [{ id: "a", type: "agent", agentId: "x" }],
      [{ from: "ghost", to: "a" }],
    ),
    /references unknown node/i,
  );
});

test("defineWorkflow: 自环报错", () => {
  assert.throws(
    () => wf(
      [{ id: "a", type: "agent", agentId: "x" }],
      [{ from: "a", to: "a" }],
    ),
    /self-loop|cycle/i,
  );
});

test("defineWorkflow: 循环依赖报错", () => {
  assert.throws(
    () => wf(
      [{ id: "a", type: "agent", agentId: "x" }, { id: "b", type: "agent", agentId: "x" }, { id: "c", type: "agent", agentId: "x" }],
      [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }],
    ),
    /cycle/i,
  );
});

test("defineWorkflow: agent 节点必须有 agentId", () => {
  assert.throws(
    () => wf([{ id: "a", type: "agent" }], []),
    /agentId/i,
  );
});

// ===== topoSort 测试：5 种 DAG 形状 =====

test("topoSort: 串行 (A→B→C) 分成 3 层", () => {
  const def = wf(
    [{ id: "a", type: "agent", agentId: "x" }, { id: "b", type: "agent", agentId: "x" }, { id: "c", type: "agent", agentId: "x" }],
    [{ from: "a", to: "b" }, { from: "b", to: "c" }],
  );
  const layers = topoSort(def);
  assert.equal(layers.length, 3);
  assert.deepEqual(layers[0], ["a"]);
  assert.deepEqual(layers[1], ["b"]);
  assert.deepEqual(layers[2], ["c"]);
});

test("topoSort: 并行 (A, B 无依赖) 同层", () => {
  const def = wf(
    [{ id: "a", type: "agent", agentId: "x" }, { id: "b", type: "agent", agentId: "x" }],
    [],
  );
  const layers = topoSort(def);
  assert.equal(layers.length, 1);
  // 同层顺序不保证，用 sort 比较
  assert.deepEqual([...layers[0]].sort(), ["a", "b"]);
});

test("topoSort: 扇出汇聚 (A→{B,C}→D)", () => {
  const def = wf(
    [
      { id: "a", type: "agent", agentId: "x" },
      { id: "b", type: "agent", agentId: "x" },
      { id: "c", type: "agent", agentId: "x" },
      { id: "d", type: "agent", agentId: "x" },
    ],
    [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }],
  );
  const layers = topoSort(def);
  assert.equal(layers.length, 3);
  assert.deepEqual(layers[0], ["a"]);
  assert.deepEqual([...layers[1]].sort(), ["b", "c"]);
  assert.deepEqual(layers[2], ["d"]);
});

test("topoSort: dataEdge 不影响分层（仍按执行依赖排）", () => {
  // A --dataEdge--> B, C --execEdge--> B
  // B 的执行依赖是 C，dataEdge 只传数据不影响排序
  const def = wf(
    [
      { id: "a", type: "agent", agentId: "x" },
      { id: "b", type: "agent", agentId: "x" },
      { id: "c", type: "agent", agentId: "x" },
    ],
    [{ from: "a", to: "b", dataEdge: true }, { from: "c", to: "b" }],
  );
  const layers = topoSort(def);
  // a 和 c 同层（无相互依赖），b 在第二层（等 c 完成）
  assert.equal(layers.length, 2);
  assert.deepEqual([...layers[0]].sort(), ["a", "c"]);
  assert.deepEqual(layers[1], ["b"]);
});

test("topoSort: 单节点", () => {
  const def = wf([{ id: "solo", type: "agent", agentId: "x" }], []);
  const layers = topoSort(def);
  assert.equal(layers.length, 1);
  assert.deepEqual(layers[0], ["solo"]);
});
