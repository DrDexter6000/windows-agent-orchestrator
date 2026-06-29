import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTemplate } from "../../src/workflow/loader.js";
import { loadWorkflow } from "../../src/workflow/loader.js";

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "wao-wf-load-"));
}

test("loadWorkflow: 加载合法 workflow export（裸对象，loader 内部校验）", async () => {
  const dir = await makeTempDir();
  try {
    const file = join(dir, "test.mjs");
    await writeFile(file, `
      export default {
        id: "test-wf",
        nodes: [{ id: "a", type: "agent", agentId: "x" }],
        edges: [],
      };
    `);
    const def = await loadWorkflow(file);
    assert.equal(def.id, "test-wf");
    assert.equal(def.nodes.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadWorkflow: 加载裸对象 export", async () => {
  const dir = await makeTempDir();
  try {
    const file = join(dir, "bare.mjs");
    await writeFile(file, `
      export default {
        id: "bare-wf",
        nodes: [{ id: "a", type: "agent", agentId: "x" }],
        edges: [],
      };
    `);
    const def = await loadWorkflow(file);
    assert.equal(def.id, "bare-wf");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadWorkflow: 文件不存在报错", async () => {
  await assert.rejects(
    () => loadWorkflow("nonexistent.mjs"),
    /Cannot find module|not found|ENOENT|ERR_MODULE_NOT_FOUND|invalid|fail/i,
  );
});

test("loadWorkflow: export 不是对象/函数报错", async () => {
  const dir = await makeTempDir();
  try {
    const file = join(dir, "bad.mjs");
    await writeFile(file, `export default "not a workflow";`);
    await assert.rejects(
      () => loadWorkflow(file),
      /invalid workflow export|expected.*object/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ===== 参数式 DAG：applyTemplate =====

test("applyTemplate 替换 agentId 占位符", () => {
  const wf = { id: "t", nodes: [{ id: "a", type: "agent", agentId: "{{coder}}" }], edges: [] };
  const result = applyTemplate(wf, { coder: "glm_worker" });
  assert.equal(result.nodes[0].agentId, "glm_worker");
});

test("applyTemplate 替换 prompt 占位符", () => {
  const wf = {
    id: "t",
    nodes: [{ id: "a", type: "agent", agentId: "x", prompt: "实现 {{feature}} 功能" }],
    edges: [],
  };
  const result = applyTemplate(wf, { feature: "登录" });
  assert.equal(result.nodes[0].prompt, "实现 登录 功能");
});

test("applyTemplate 替换 requiredClaims 占位符", () => {
  const wf = {
    id: "t",
    nodes: [{ id: "a", type: "gate", requiredClaims: ["{{claim1}}", "status"] }],
    edges: [],
  };
  const result = applyTemplate(wf, { claim1: "files_written" });
  assert.deepEqual(result.nodes[0].requiredClaims, ["files_written", "status"]);
});

test("applyTemplate 多个占位符同时替换", () => {
  const wf = {
    id: "t",
    nodes: [
      { id: "a", type: "agent", agentId: "{{worker}}", prompt: "做 {{task}}" },
      { id: "b", type: "agent", agentId: "{{reviewer}}", prompt: "审查 {{task}}" },
    ],
    edges: [],
  };
  const result = applyTemplate(wf, { worker: "coder", reviewer: "auditor", task: "重构" });
  assert.equal(result.nodes[0].agentId, "coder");
  assert.equal(result.nodes[0].prompt, "做 重构");
  assert.equal(result.nodes[1].agentId, "auditor");
  assert.equal(result.nodes[1].prompt, "审查 重构");
});

test("applyTemplate 无 vars 时原样返回（不报错）", () => {
  const wf = { id: "t", nodes: [{ id: "a", type: "agent", agentId: "fixed" }], edges: [] };
  const result = applyTemplate(wf);
  assert.equal(result.nodes[0].agentId, "fixed");
});

test("applyTemplate 未提供的占位符保持原样（不崩）", () => {
  const wf = { id: "t", nodes: [{ id: "a", type: "agent", agentId: "{{missing}}" }], edges: [] };
  const result = applyTemplate(wf, { other: "x" });
  assert.equal(result.nodes[0].agentId, "{{missing}}");
});

test("applyTemplate 不修改原始 workflow（返回新对象）", () => {
  const wf = { id: "t", nodes: [{ id: "a", type: "agent", agentId: "{{x}}" }], edges: [] };
  applyTemplate(wf, { x: "y" });
  assert.equal(wf.nodes[0].agentId, "{{x}}", "original should be unchanged");
});

test("applyTemplate 替换 scorecard rules 里的占位符", () => {
  const wf = {
    id: "t",
    nodes: [{
      id: "a", type: "agent", agentId: "x",
      scorecard: { rules: { requireFiles: ["{{output_file}}"] } },
    }],
    edges: [],
  };
  const result = applyTemplate(wf, { output_file: "result.js" });
  assert.deepEqual(result.nodes[0].scorecard.rules.requireFiles, ["result.js"]);
});

// --- F4: workflow 模板默认带最小 scorecard（让验收默认生效）---
// 原问题：scorecard 是 opt-in，lead 不主动配就形同虚设，验收退化到纯语义判断。
// 修复：自带模板里执行写操作的 worker 节点默认带 scorecard（requireEvidence:true）。
// 本测试锁定这些模板的 worker 节点带 scorecard，防回退。
test("F4: 自带 workflow 模板的 worker 节点默认带 scorecard", async () => {
  const { loadWorkflow } = await import("../../src/workflow/loader.js");
  const { resolve } = await import("node:path");
  const wfRoot = resolve(import.meta.dirname, "..", "..", "workflows");
  for (const file of ["analyze-summarize.mjs", "parallel-verify.mjs"]) {
    const def = await loadWorkflow(resolve(wfRoot, file));
    const workerNodes = def.nodes.filter((n) => n.type === "agent" && n.agentId !== "researcher");
    // 执行写操作（非纯只读 researcher）的 worker 节点应带 scorecard
    for (const n of workerNodes) {
      assert.ok(n.scorecard, `${file} 的 worker 节点 ${n.id} 应带 scorecard（默认验收）`);
      assert.equal(n.scorecard.rules?.requireEvidence, true,
        `${file} 的 ${n.id} 应 requireEvidence:true（最小验收门）`);
    }
  }
});
