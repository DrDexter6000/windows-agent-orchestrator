import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineWorkflow } from "../../src/workflow/schema.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";

/** mock RunManager：记录调用顺序，可控制成功/失败 */
function mockRunManager(failNodes = []) {
  const order = [];
  let counter = 0;
  return {
    order,
    async start(agentId, opts) {
      counter += 1;
      const runId = `run_${counter}`;
      order.push({ agentId, runId, prompt: opts.prompt, opts });
      const shouldFail = failNodes.includes(agentId) || failNodes.includes(opts.prompt);
      return {
        runId,
        transcript: { filePath: `/tmp/${runId}.jsonl` },
        async waitForCompletion() {
          return {
            completed: !shouldFail,
            messages: shouldFail ? [] : [{ info: { role: "assistant" }, parts: [{ type: "text", text: `output_${runId}` }] }],
            metrics: shouldFail ? null : { tokens: { input: 10, output: 5 } },
          };
        },
      };
    },
  };
}

function makeEngine(rm) {
  return new WorkflowEngine({ runManager: rm });
}

// ===== 5 种 DAG 形状 =====

test("串行 (A→B→C) 按序执行", async () => {
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "serial",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
      { id: "c", type: "agent", agentId: "w", prompt: "c" },
    ],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.equal(result.completed, true);
  // 执行顺序必须 a→b→c
  assert.deepEqual(rm.order.map((c) => c.prompt), ["a", "b", "c"]);
});

test("并行 (A, B 同层) 都执行", async () => {
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "parallel",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
    ],
    edges: [],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.equal(result.completed, true);
  assert.equal(rm.order.length, 2);
  const prompts = rm.order.map((c) => c.prompt).sort();
  assert.deepEqual(prompts, ["a", "b"]);
});

test("TD-27: 同层某 handler 抛异常不废掉整层（allSettled + per-node catch）", async () => {
  // 真实 bug：engine 用 Promise.all 无 per-node catch → 一个 handler 抛错 = 整层 reject，
  // 未完成的兄弟节点结果丢失，且 execute() 直接 throw（不返回结构化结果）。
  // 修复后：抛错节点标记为 completed:false（带 error），兄弟节点照常执行，workflow 整体 completed:false。
  const rm = mockRunManager();
  // 让 a 的 start 抛异常（模拟 handler 内部 bug / promptBuilder 抛错 / 非 backend 异常）
  const origStart = rm.start.bind(rm);
  rm.start = async (agentId, opts) => {
    if (opts.prompt === "a") throw new Error("handler blew up (non-backend exception)");
    return origStart(agentId, opts);
  };
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "partial-fail",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
    ],
    edges: [],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  // 关键：execute 不抛，返回结构化结果
  assert.equal(result.completed, false, "整层一个失败 → workflow completed:false");
  // 兄弟节点 b 照常执行（不被 a 的异常拖死）
  assert.ok(rm.order.some((c) => c.prompt === "b"), "兄弟节点 b 应照常执行，不被 a 的异常拖死");
  // a 的失败结果被记录（含 error），而非整层丢失
  assert.ok(result.nodeResults.a, "a 的结果应被记录");
  assert.equal(result.nodeResults.a.completed, false, "a 应标记 completed:false");
  assert.ok(result.nodeResults.a.error, "a 的结果应含 error 字段");
});

test("TD-30: workflow 级整体超时（workflowTimeout）截断执行并返回 timedOut", async () => {
  // 真实缺口：execute() 无整体超时，一个 workflow 理论上能无限跑（只有单节点 waitTimeout）。
  // 修复后：传入 workflowTimeout 时，每层开始前检查已超时 → 截断，返回 {completed:false, timedOut:true}。
  const rm = mockRunManager();
  // 让节点 start 慢（200ms），workflowTimeout 设 50ms → 第 1 层未跑完就到 deadline
  const origStart = rm.start.bind(rm);
  rm.start = async (agentId, opts) => {
    await new Promise((r) => setTimeout(r, 200));
    return origStart(agentId, opts);
  };
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "wf-timeout",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" }, // b 在第 2 层，应被超时截断
    ],
    edges: [{ from: "a", to: "b" }],
  });
  const start = Date.now();
  const result = await engine.execute(wf, {
    workflowTimeout: 50,
    cwd: join(tmpdir(), "wao-test-disabled"),
  });
  const elapsed = Date.now() - start;
  assert.equal(result.completed, false, "超时应使 workflow completed:false");
  assert.equal(result.timedOut, true, "应返回 timedOut:true 标记");
  // b 在第 2 层，a 跑 200ms > 50ms deadline，b 不应执行
  assert.ok(!rm.order.some((c) => c.prompt === "b"), "deadline 后的层应被截断，b 不执行");
  // 不应傻等所有层（elapsed 远小于 2*200ms）
  assert.ok(elapsed < 350, `应在 deadline 后尽快返回，实际 ${elapsed}ms`);
});

test("TD-30: 不传 workflowTimeout 时不影响原有行为（向后兼容）", async () => {
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "no-timeout",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
    ],
    edges: [{ from: "a", to: "b" }],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.equal(result.completed, true);
  assert.ok(!("timedOut" in result) || result.timedOut === false || result.timedOut === undefined,
    "无 workflowTimeout 时不应误报 timedOut");
});

test("扇出汇聚 (A→{B,C}→D) 正确等待", async () => {
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "fanout",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
      { id: "c", type: "agent", agentId: "w", prompt: "c" },
      { id: "d", type: "agent", agentId: "w", prompt: "d" },
    ],
    edges: [
      { from: "a", to: "b" }, { from: "a", to: "c" },
      { from: "b", to: "d" }, { from: "c", to: "d" },
    ],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.equal(result.completed, true);
  // a 先，d 最后
  assert.equal(rm.order[0].prompt, "a");
  assert.equal(rm.order.at(-1).prompt, "d");
});

test("gate 不通过 → 下游不执行", async () => {
  const rm = mockRunManager(["a"]); // a 失败
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "gate-fail",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "g", type: "gate", requiredClaims: ["a.text"] },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
    ],
    edges: [{ from: "a", to: "g" }, { from: "g", to: "b" }],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  // a 失败 → gate 检查前驱未完成 → 不通过 → b 不执行
  const executedPrompts = rm.order.map((c) => c.prompt);
  assert.ok(!executedPrompts.includes("b"), "b should not execute");
});

test("节点失败 → 下游不执行（失败传播）", async () => {
  const rm = mockRunManager(["a"]); // a 失败
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "fail-prop",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
    ],
    edges: [{ from: "a", to: "b" }],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  const executedPrompts = rm.order.map((c) => c.prompt);
  assert.ok(executedPrompts.includes("a"), "a should execute");
  assert.ok(!executedPrompts.includes("b"), "b should NOT execute (failure propagation)");
  assert.equal(result.completed, false);
});

test("dataEdge: 数据先传，但执行仍等执行依赖", async () => {
  // A --dataEdge--> B, C --execEdge--> B
  // B 的 upstream 同时有 A 和 C 的数据，但 B 等 C 完成后才启动
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "data-dep",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "c", type: "agent", agentId: "w", prompt: "c" },
      {
        id: "b", type: "agent", agentId: "w",
        promptBuilder: (ctx) => `a=${ctx.upstream.a?.runId} c=${ctx.upstream.c?.runId}`,
      },
    ],
    edges: [
      { from: "a", to: "b", dataEdge: true },
      { from: "c", to: "b" },
    ],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.equal(result.completed, true);
  // b 的 prompt 应同时包含 a 和 c 的 runId（两者都完成后才执行）
  const bCall = rm.order.find((c) => c.prompt.startsWith("a="));
  assert.ok(bCall, "b should execute");
  assert.match(bCall.prompt, /a=run_\d+/);
  assert.match(bCall.prompt, /c=run_\d+/);
});

test("router: 条件路由选择下游", async () => {
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "router",
    nodes: [
      { id: "check", type: "agent", agentId: "w", prompt: "check" },
      { id: "decide", type: "router", routes: () => "go" },
      { id: "go", type: "agent", agentId: "w", prompt: "go" },
      { id: "stop", type: "agent", agentId: "w", prompt: "stop" },
    ],
    edges: [
      { from: "check", to: "decide" },
      { from: "decide", to: "go" },
      { from: "decide", to: "stop" },
    ],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.equal(result.completed, true);
  const prompts = rm.order.map((c) => c.prompt);
  assert.ok(prompts.includes("go"), "go should execute (selected by router)");
  assert.ok(!prompts.includes("stop"), "stop should NOT execute (not selected)");
});

test("TD-28: router 下游同时是 dataEdge 时数据传递 + 路由过滤都生效", async () => {
  // 组合拓扑：check --execEdge--> decide(router)；check --dataEdge--> go；decide --execEdge--> go/stop
  // go 是 router 选中的下游，同时通过 dataEdge 接收 check 的数据。
  // 预期：go 执行且 upstream 含 check 数据；stop 不执行（路由未选）。
  // 这个组合之前未测（router 测和 dataEdge 测各自独立）。
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "router-dataedge",
    nodes: [
      { id: "check", type: "agent", agentId: "w", prompt: "check" },
      { id: "decide", type: "router", routes: () => "go" },
      {
        id: "go", type: "agent", agentId: "w",
        promptBuilder: (ctx) => `go with check=${ctx.upstream.check?.runId}`,
      },
      { id: "stop", type: "agent", agentId: "w", prompt: "stop" },
    ],
    edges: [
      { from: "check", to: "decide" },
      { from: "check", to: "go", dataEdge: true },
      { from: "decide", to: "go" },
      { from: "decide", to: "stop" },
    ],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.equal(result.completed, true);
  const prompts = rm.order.map((c) => c.prompt);
  assert.ok(prompts.some((p) => p.startsWith("go with check=")), "go 应执行且 promptBuilder 能拿到 check 的 dataEdge 数据");
  assert.ok(!prompts.includes("stop"), "stop 不应执行（路由未选）");
  // go 的 prompt 应含 check 的 runId（dataEdge 数据传到了）
  const goCall = rm.order.find((c) => c.prompt.startsWith("go with check="));
  assert.match(goCall.prompt, /check=run_\d+/, "dataEdge 数据应传递到 go");
});

test("WorkflowResult 含所有节点的结果", async () => {
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "result-map",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
    ],
    edges: [{ from: "a", to: "b" }],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.ok(result.nodeResults.a, "should have result for a");
  assert.ok(result.nodeResults.b, "should have result for b");
  assert.equal(result.nodeResults.a.completed, true);
});

test("workflow agent nodes inherit runDir option for child run transcripts", async () => {
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "run-dir",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
    ],
    edges: [],
  });

  await engine.execute(wf, { runDir: "D:/tmp/custom-runs", cwd: join(tmpdir(), "wao-test-disabled") });

  assert.equal(rm.order[0].opts.runDir, "D:/tmp/custom-runs");
});

test("workflow agent nodes inherit registry option for certification runs", async () => {
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "registry",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
    ],
    edges: [],
  });

  await engine.execute(wf, { registry: "D:/tmp/agents.json", cwd: join(tmpdir(), "wao-test-disabled") });

  assert.equal(rm.order[0].opts.registry, "D:/tmp/agents.json");
});

test("C1: workflow 节点的 scorecard 配置传给 RunManager（修审计 P1-a 静默失效 bug）", async () => {
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "wf_scorecard",
    nodes: [{
      id: "a", type: "agent", agentId: "worker", prompt: "do A",
      scorecard: { rules: { requireFiles: ["src/output.js"] } },
    }],
    edges: [],
  });
  await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.equal(rm.order.length, 1, "应派发 1 个 run");
  assert.ok(rm.order[0].opts.scorecard, "node.scorecard 应传给 RunManager.start 的 options");
  assert.deepEqual(
    rm.order[0].opts.scorecard.rules.requireFiles,
    ["src/output.js"],
    "scorecard rules 内容应完整传递",
  );
});

// ---------------------------------------------------------------------------
// M8-5：Integrator 节点（🔵 工具起草域——拼初稿，Lead 终验）。
//
// 设计：integrator 节点收集所有前驱 output.text，去重+按拓扑序拼成 integrator.draft，
// 放进自己的 output。节点自身 completed:true（拼了初稿就算完），但不判定交付质量——
// 必须由后续 gate/agent 节点或 Lead 读取 draft 后人工终验。
// 不自动跑"完整性 gate"（用户否决自动 gate）。
//
// 关键：draft 通过 ctx.upstream 可被下游节点引用（同 agent 节点链式机制）。
// ---------------------------------------------------------------------------

test("M8-5: 3 个前驱 agent → integrator.draft 含 3 段文本，去重", async () => {
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "fanin",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
      { id: "c", type: "agent", agentId: "w", prompt: "c" },
      { id: "integ", type: "integrator" },
    ],
    edges: [
      { from: "a", to: "integ" },
      { from: "b", to: "integ" },
      { from: "c", to: "integ" },
    ],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.equal(result.completed, true, "integrator 拼了初稿即 completed");
  const integ = result.nodeResults.integ;
  assert.ok(integ, "应有 integrator 节点结果");
  assert.ok(integ.output, "integrator 应有 output");
  assert.ok(typeof integ.output.draft === "string", "output.draft 应是拼接字符串");
  // mock 产出 output_run_1/2/3，draft 应含全部三段
  assert.match(integ.output.draft, /output_run_1/);
  assert.match(integ.output.draft, /output_run_2/);
  assert.match(integ.output.draft, /output_run_3/);
  // sources 记录来源节点
  assert.ok(Array.isArray(integ.output.sources), "应记录 sources 来源节点列表");
  assert.equal(integ.output.sources.length, 3);
});

test("M8-5: draft 去重——重复文本只出现一次", async () => {
  // 构造两个前驱返回相同文本（模拟重复产出）
  const rm = mockRunManager();
  rm.start = async () => ({
    runId: "run_dup",
    transcript: { filePath: "/tmp/run_dup.jsonl" },
    async waitForCompletion() {
      return {
        completed: true,
        messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "SAME_TEXT" }] }],
        metrics: { tokens: { input: 1 } },
      };
    },
  });
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "dedup",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
      { id: "integ", type: "integrator" },
    ],
    edges: [{ from: "a", to: "integ" }, { from: "b", to: "integ" }],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  const draft = result.nodeResults.integ.output.draft;
  // 两段相同文本去重后应只出现一次
  const occurrences = (draft.match(/SAME_TEXT/g) ?? []).length;
  assert.equal(occurrences, 1, "重复文本去重后应只出现一次");
});

test("M8-5: 某前驱未 completed → draft 标注缺失但不崩（不自动判失败）", async () => {
  const rm = mockRunManager(["b"]); // b 失败
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "partial",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
      { id: "integ", type: "integrator" },
    ],
    edges: [{ from: "a", to: "integ" }, { from: "b", to: "integ" }],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  // 关键：b 失败 → propagateFailure 把 integ 标 skipped（engine 行为），
  // integ 不应执行。但若 integ 仍执行（如设计改为容忍），draft 应标注缺失而非崩。
  // 此测试锁定：失败传播下 integ 被 skipped（不执行 integrator，不自动判质量）。
  assert.ok(result.nodeResults.integ === undefined || result.nodeResults.integ.completed === false,
    "b 失败 → integ 应被 skipped 或不执行（不自动跑整合）");
  assert.equal(result.completed, false, "前驱失败 → workflow completed:false");
});

test("M8-5: getHandler('integrator') 不抛（已注册）", async () => {
  const { getHandler } = await import("../../src/workflow/handlers.js");
  const h = getHandler("integrator");
  assert.ok(h, "integrator handler 应已注册");
  assert.equal(typeof h.execute, "function", "handler 应有 execute 方法");
});

test("M8-5: integrator 节点 output 经 ctx.upstream 可被下游引用（链式）", async () => {
  const rm = mockRunManager();
  const engine = makeEngine(rm);
  // A → integ → C：C 的 promptBuilder 读 ctx.upstream.integ.output.draft
  const wf = defineWorkflow({
    id: "chain",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "integ", type: "integrator" },
      {
        id: "c", type: "agent", agentId: "w",
        promptBuilder: (ctx) => `consume: ${ctx.upstream?.integ?.output?.draft ?? "NONE"}`,
      },
    ],
    edges: [{ from: "a", to: "integ" }, { from: "integ", to: "c" }],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.equal(result.completed, true);
  // c 的 prompt 应含 integ 拼出的 draft 内容
  const cCall = rm.order.find((o) => o.prompt && o.prompt.startsWith("consume:"));
  assert.ok(cCall, "下游 c 应被调用");
  assert.match(cCall.prompt, /output_run_1/, "c 的 prompt 应引用 integrator 的 draft");
});

// ---------------------------------------------------------------------------
// TD-102 Batch 1B: WorkflowEngine.execute() returns skipped node IDs
// ---------------------------------------------------------------------------

test("TD-102: first-layer failure → execute() returns skipped downstream node IDs", async () => {
  const rm = mockRunManager(["a"]); // a fails
  const engine = makeEngine(rm);
  const wf = defineWorkflow({
    id: "skip-test",
    nodes: [
      { id: "a", type: "agent", agentId: "w", prompt: "a" },
      { id: "b", type: "agent", agentId: "w", prompt: "b" },
      { id: "c", type: "agent", agentId: "w", prompt: "c" },
    ],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
  });
  const result = await engine.execute(wf, { cwd: join(tmpdir(), "wao-test-disabled") });
  assert.equal(result.completed, false);
  // execute() must return skipped node IDs
  assert.ok(Array.isArray(result.skipped), "execute() should return a skipped array");
  assert.ok(result.skipped.includes("b"), "b should be in skipped");
  assert.ok(result.skipped.includes("c"), "c should be in skipped");
});
