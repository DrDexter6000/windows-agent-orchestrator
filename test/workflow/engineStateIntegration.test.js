import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow } from "../../src/workflow/schema.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { initWaoDir, getWaoDir } from "../../src/waoDir.js";
import { readCurrentState } from "../../src/waoState.js";

/** mock RunManager（照 engine.test.js 模式）*/
function mockRunManager(failNodes = []) {
  let counter = 0;
  return {
    async start(agentId, opts) {
      counter += 1;
      const runId = `run_${counter}`;
      const shouldFail = failNodes.includes(agentId);
      return {
        runId,
        transcript: { filePath: `/tmp/${runId}.jsonl` },
        async waitForCompletion() {
          return {
            completed: !shouldFail,
            messages: shouldFail ? [] : [{ info: { role: "assistant" }, parts: [{ type: "text", text: `output_${runId}` }] }],
            metrics: { tokens: { input: 10, output: 5 } },
          };
        },
      };
    },
  };
}

async function makeTempProjectWithWao() {
  const dir = await mkdtemp(join(tmpdir(), "wao-eng-"));
  await initWaoDir(dir);
  return dir;
}

test("S3-2 端到端: 串行 workflow (A→B→C) 跑完 → state/current.md 含全部节点", async () => {
  const dir = await makeTempProjectWithWao();
  try {
    const rm = mockRunManager();
    const engine = new WorkflowEngine({ runManager: rm });
    const wf = defineWorkflow({
      id: "wf_serial",
      nodes: [
        { id: "a", type: "agent", agentId: "worker", prompt: "do A" },
        { id: "b", type: "agent", agentId: "worker", prompt: "do B" },
        { id: "c", type: "agent", agentId: "worker", prompt: "do C" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    });
    const result = await engine.execute(wf, { cwd: dir });
    assert.equal(result.completed, true);

    const waoDir = getWaoDir(dir);
    const state = await readCurrentState(waoDir);
    assert.ok(state, "state 应被写入");
    assert.equal(state.workflowId, "wf_serial");
    assert.equal(state.status, "completed", "全部完成应标 completed");
    // 三个节点都在 steps 里
    const nodeIds = state.steps.map((s) => s.node);
    assert.ok(nodeIds.includes("a") && nodeIds.includes("b") && nodeIds.includes("c"),
      `steps 应含 a/b/c，got ${nodeIds.join(",")}`);
    // 都标 completed
    for (const s of state.steps) {
      assert.equal(s.status, "completed", `节点 ${s.node} 应 completed`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-2 端到端: 节点失败 → state 标 failed + 下游 skipped", async () => {
  const dir = await makeTempProjectWithWao();
  try {
    const rm = mockRunManager(["b"]); // b 失败
    const engine = new WorkflowEngine({ runManager: rm });
    const wf = defineWorkflow({
      id: "wf_fail",
      nodes: [
        { id: "a", type: "agent", agentId: "worker", prompt: "A" },
        { id: "b", type: "agent", agentId: "b", prompt: "B fails" },
        { id: "c", type: "agent", agentId: "worker", prompt: "C" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    });
    await engine.execute(wf, { cwd: dir });

    const state = await readCurrentState(getWaoDir(dir));
    const bStep = state.steps.find((s) => s.node === "b");
    const cStep = state.steps.find((s) => s.node === "c");
    assert.equal(bStep.status, "failed", "b 应标 failed");
    assert.equal(cStep.status, "skipped", "c 应标 skipped（失败传播）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-2 端到端: state/current.md 含 run 引用（传引用不传内容）", async () => {
  const dir = await makeTempProjectWithWao();
  try {
    const rm = mockRunManager();
    const engine = new WorkflowEngine({ runManager: rm });
    const wf = defineWorkflow({
      id: "wf_refs",
      nodes: [{ id: "x", type: "agent", agentId: "worker", prompt: "X" }],
      edges: [],
    });
    await engine.execute(wf, { cwd: dir });

    const current = await readFile(join(getWaoDir(dir), "state", "current.md"), "utf8");
    // Upstream refs 段含 transcript 路径引用
    assert.match(current, /Upstream refs/, "应有 Upstream refs 段");
    assert.match(current, /\/tmp\/run_1\.jsonl/, "应含 run 的 transcript 引用");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-2 端到端: .wao/ 未 init → engine 不崩，workflow 正常完成", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-noinit-eng-"));
  try {
    const rm = mockRunManager();
    const engine = new WorkflowEngine({ runManager: rm });
    const wf = defineWorkflow({
      id: "wf_noinit",
      nodes: [{ id: "a", type: "agent", agentId: "worker", prompt: "A" }],
      edges: [],
    });
    // 不 init .wao/，直接跑
    const result = await engine.execute(wf, { cwd: dir });
    assert.equal(result.completed, true, "未 init 不应阻断 workflow");
    // state/current.md 不存在（没 init）
    assert.ok(!existsSync(join(getWaoDir(dir), "state", "current.md")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- TD-102 审计收尾: timeout outcome edges ---

test("TD-102 timeout: 超时后 .wao/state 必须 failed（不是 in_progress）", async () => {
  const dir = await makeTempProjectWithWao();
  try {
    // 让节点 start 慢（200ms），workflowTimeout=50ms → 第 1 层未跑完就到 deadline
    const rm = mockRunManager();
    const origStart = rm.start.bind(rm);
    rm.start = async (agentId, opts) => {
      await new Promise((r) => setTimeout(r, 200));
      return origStart(agentId, opts);
    };
    const engine = new WorkflowEngine({ runManager: rm });
    const wf = defineWorkflow({
      id: "wf_timeout",
      nodes: [
        { id: "a", type: "agent", agentId: "worker", prompt: "A" },
        { id: "b", type: "agent", agentId: "worker", prompt: "B" }, // 第 2 层，应被超时截断
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const result = await engine.execute(wf, { workflowTimeout: 50, cwd: dir });
    assert.equal(result.completed, false, "超时 → completed:false");
    assert.equal(result.timedOut, true, "timedOut:true");

    // 核心断言：state snapshot 必须是 failed，不是 in_progress
    const state = await readCurrentState(getWaoDir(dir));
    assert.ok(state, "state 应被写入");
    assert.equal(state.status, "failed", "超时后 state 必须 failed（不是 in_progress）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-102 timeout: 超时未执行的节点不伪装 skipped（CLI 可区分）", async () => {
  const dir = await makeTempProjectWithWao();
  try {
    const rm = mockRunManager();
    const origStart = rm.start.bind(rm);
    rm.start = async (agentId, opts) => {
      await new Promise((r) => setTimeout(r, 200));
      return origStart(agentId, opts);
    };
    const engine = new WorkflowEngine({ runManager: rm });
    const wf = defineWorkflow({
      id: "wf_timeout_skip",
      nodes: [
        { id: "a", type: "agent", agentId: "worker", prompt: "A" },
        { id: "b", type: "agent", agentId: "worker", prompt: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const result = await engine.execute(wf, { workflowTimeout: 50, cwd: dir });
    // b 在第 2 层被 timeout 截断——不应在 skipped 中
    assert.ok(!result.skipped.includes("b"), "超时截断的 b 不应伪装为 skipped");
    // b 也不应在 nodeResults 中（未执行）
    assert.ok(!result.nodeResults.b, "b 不应在 nodeResults 中（未执行）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-102 router skip: state notes 不得写 'upstream failed'", async () => {
  const dir = await makeTempProjectWithWao();
  try {
    const rm = mockRunManager();
    const engine = new WorkflowEngine({ runManager: rm });
    const wf = defineWorkflow({
      id: "wf_router_notes",
      nodes: [
        { id: "check", type: "agent", agentId: "worker", prompt: "check" },
        { id: "decide", type: "router", routes: () => "go" },
        { id: "go", type: "agent", agentId: "worker", prompt: "go" },
        { id: "stop", type: "agent", agentId: "worker", prompt: "stop" }, // router 未选
      ],
      edges: [
        { from: "check", to: "decide" },
        { from: "decide", to: "go" },
        { from: "decide", to: "stop" },
      ],
    });
    await engine.execute(wf, { cwd: dir });

    const state = await readCurrentState(getWaoDir(dir));
    const stopStep = state.steps.find((s) => s.node === "stop");
    assert.equal(stopStep.status, "skipped", "stop 应标 skipped（router 未选）");
    // 核心断言：router skip 的 notes 不得是 "upstream failed"
    assert.notEqual(stopStep.notes, "upstream failed",
      "router 未选的节点 notes 不得写 'upstream failed'（制造错误原因）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
