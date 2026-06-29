import test from "node:test";
import assert from "node:assert/strict";
import { agentHandler, gateHandler, routerHandler, getHandler, registerHandler } from "../../src/workflow/handlers.js";
import { buildPrompt, buildUpstreamContext, checkRequiredClaims } from "../../src/workflow/handoff.js";

// ===== handoff 测试 =====

test("buildPrompt: 有 promptBuilder 时调它", () => {
  const node = { id: "a", promptBuilder: (ctx) => `upstream: ${Object.keys(ctx.upstream).join(",")}` };
  const prompt = buildPrompt(node, { upstream: { prev: { runId: "r1" } } });
  assert.equal(prompt, "upstream: prev");
});

test("buildPrompt: 无 promptBuilder 用静态 prompt", () => {
  const node = { id: "a", prompt: "static prompt" };
  assert.equal(buildPrompt(node, {}), "static prompt");
});

test("buildPrompt: 都没有时报错", () => {
  assert.throws(() => buildPrompt({ id: "a" }, {}), /no prompt/);
});

test("buildUpstreamContext: 只传引用不传 messages", () => {
  const results = new Map([
    ["a", { runId: "r1", transcriptPath: "/path/r1.jsonl", completed: true, output: { text: "..." }, messages: ["secret"] }],
  ]);
  const upstream = buildUpstreamContext(results, ["a"]);
  assert.equal(upstream.a.runId, "r1");
  assert.equal(upstream.a.transcriptPath, "/path/r1.jsonl");
  assert.equal(upstream.a.completed, true);
  // messages 不在 upstream 里（传引用不传内容）
  assert.equal(upstream.a.messages, undefined);
});

test("checkRequiredClaims: 全满足 → passed", () => {
  const node = { requiredClaims: ["a.text"] };
  const upstream = { a: { output: { text: "hello" } } };
  const { passed, missing } = checkRequiredClaims(node, upstream);
  assert.equal(passed, true);
  assert.deepEqual(missing, []);
});

test("checkRequiredClaims: 缺失 → not passed + missing 列表", () => {
  const node = { requiredClaims: ["a.text", "b.tokens"] };
  const upstream = { a: { output: { text: "hello" } } }; // b 不存在
  const { passed, missing } = checkRequiredClaims(node, upstream);
  assert.equal(passed, false);
  assert.deepEqual(missing, ["b.tokens"]);
});

// ===== handler 测试 =====

function mockRunManager() {
  const calls = [];
  return {
    calls,
    async start(agentId, opts) {
      calls.push({ agentId, prompt: opts.prompt });
      return {
        runId: `run_${calls.length}`,
        transcript: { filePath: `/tmp/run_${calls.length}.jsonl` },
        async waitForCompletion() {
          return {
            completed: true,
            messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "result" }] }],
            metrics: { tokens: { input: 10, output: 5 } },
          };
        },
      };
    },
  };
}

test("agentHandler: 调 RunManager.start + waitForCompletion", async () => {
  const rm = mockRunManager();
  const node = { id: "a", agentId: "worker", prompt: "do work" };
  const ctx = { runManager: rm, upstream: {}, options: {} };
  const result = await agentHandler.execute(node, ctx);
  assert.equal(result.completed, true);
  assert.equal(result.runId, "run_1");
  assert.equal(result.output.text, "result");
  assert.equal(rm.calls[0].prompt, "do work");
});

test("agentHandler: promptBuilder 拿到 upstream", async () => {
  const rm = mockRunManager();
  const node = {
    id: "b", agentId: "worker",
    promptBuilder: (ctx) => `based on ${ctx.upstream.a.runId}`,
  };
  const ctx = { runManager: rm, upstream: { a: { runId: "prev_run" } }, options: {} };
  await agentHandler.execute(node, ctx);
  assert.equal(rm.calls[0].prompt, "based on prev_run");
});

test("gateHandler: 前驱全 completed + claims 满足 → passed", async () => {
  const node = { id: "g", requiredClaims: ["a.text"] };
  const ctx = { upstream: { a: { completed: true, output: { text: "ok" } } } };
  const result = await gateHandler.execute(node, ctx);
  assert.equal(result.completed, true);
  assert.equal(result.output.gatePassed, true);
});

test("gateHandler: 前驱未完成 → not passed", async () => {
  const node = { id: "g" };
  const ctx = { upstream: { a: { completed: false } } };
  const result = await gateHandler.execute(node, ctx);
  assert.equal(result.completed, false);
  assert.match(result.output.reason, /not completed/);
});

test("routerHandler: routes 函数选择下游", async () => {
  const node = { id: "r", routes: (ctx) => ctx.upstream.a.completed ? "pass" : "fail" };
  const ctx = { upstream: { a: { completed: true } } };
  const result = await routerHandler.execute(node, ctx);
  assert.equal(result.completed, true);
  assert.deepEqual(result.routes, ["pass"]);
});

test("getHandler: 未知 type 报错", () => {
  assert.throws(() => getHandler("nonexistent"), /unknown node type/);
});

test("registerHandler: 注册自定义 handler", () => {
  const custom = { async execute() { return { completed: true, output: {} }; } };
  registerHandler("custom-test", custom);
  const h = getHandler("custom-test");
  assert.equal(h, custom);
});
