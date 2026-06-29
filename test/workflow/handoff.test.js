import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, buildUpstreamContext, checkRequiredClaims } from "../../src/workflow/handoff.js";

// ===== buildPrompt 测试 =====

test("buildPrompt: promptBuilder 返回有效字符串 → 原样使用", () => {
  const node = { id: "a", promptBuilder: (ctx) => `upstream: ${Object.keys(ctx.upstream).join(",")}` };
  const prompt = buildPrompt(node, { upstream: { prev: { runId: "r1" } } });
  assert.equal(prompt, "upstream: prev");
});

test("buildPrompt: promptBuilder 返回非字符串 → 报错", () => {
  const node = { id: "a", promptBuilder: () => 42 };
  assert.throws(() => buildPrompt(node, {}), /must return a string/);
});

test("buildPrompt: 既无 prompt 也无 promptBuilder → 报错", () => {
  assert.throws(() => buildPrompt({ id: "a" }, {}), /no prompt/);
});

test("buildPrompt: 用静态 prompt 字符串", () => {
  const node = { id: "a", prompt: "static prompt" };
  assert.equal(buildPrompt(node, {}), "static prompt");
});

test("buildPrompt: 空字符串 prompt 视为有效", () => {
  const node = { id: "a", prompt: "" };
  assert.equal(buildPrompt(node, {}), "");
});

// ===== buildUpstreamContext 测试 =====

test("buildUpstreamContext: 正常路径只传引用不传 messages", () => {
  const results = new Map([
    ["a", { runId: "r1", transcriptPath: "/path/r1.jsonl", completed: true, output: { text: "..." }, messages: ["secret"] }],
  ]);
  const upstream = buildUpstreamContext(results, ["a"]);
  assert.equal(upstream.a.runId, "r1");
  assert.equal(upstream.a.transcriptPath, "/path/r1.jsonl");
  assert.equal(upstream.a.completed, true);
  assert.deepEqual(upstream.a.output, { text: "..." });
  // messages 不在 upstream 里（传引用不传内容）
  assert.equal(upstream.a.messages, undefined);
});

test("buildUpstreamContext: 空 predecessorIds → 空对象", () => {
  const results = new Map([["a", { runId: "r1" }]]);
  const upstream = buildUpstreamContext(results, []);
  assert.deepEqual(upstream, {});
});

test("buildUpstreamContext: results 中缺失的前驱被跳过", () => {
  const results = new Map([
    ["a", { runId: "r1", transcriptPath: "/p/r1.jsonl", completed: true, output: {} }],
  ]);
  const upstream = buildUpstreamContext(results, ["a", "b"]);
  assert.deepEqual(Object.keys(upstream), ["a"]);
  assert.equal(upstream.b, undefined);
});

// ===== P4 融合项 #2：ctx.upstream.X 便捷别名（决策 0010 语义对齐）=====
// 决策 0010：引擎注入 ctx.upstream.X.text，让声明式链式 = 手动链式一样简单（消除人肉 relay，P0-F1）。
// output 已透传（见上），但语义是多一层间接（upstream.X.output.text）。这里加一等别名 text/tokens/costUsd
// 直接挂在 upstream[id] 上，对齐决策 0010 的 ctx.upstream.X.text 写法。output 结构保留（向后兼容）。

test("buildUpstreamContext: output.text 暴露为 upstream[id].text 别名（决策 0010 语义）", () => {
  const results = new Map([
    ["a", { runId: "r1", completed: true, output: { text: "调研结论：auth 模块在 src/auth" } }],
  ]);
  const upstream = buildUpstreamContext(results, ["a"]);
  assert.equal(upstream.a.text, "调研结论：auth 模块在 src/auth", "text 应直接可达（消除 .output 间接）");
  assert.equal(upstream.a.output.text, "调研结论：auth 模块在 src/auth", "output.text 仍保留（向后兼容）");
});

test("buildUpstreamContext: output.tokens/costUsd 暴露为 upstream[id].tokens/costUsd 别名", () => {
  const results = new Map([
    ["a", { runId: "r1", completed: true, output: { text: "x", tokens: 1234, costUsd: 0.05 } }],
  ]);
  const upstream = buildUpstreamContext(results, ["a"]);
  assert.equal(upstream.a.tokens, 1234, "tokens 别名");
  assert.equal(upstream.a.costUsd, 0.05, "costUsd 别名");
});

test("buildUpstreamContext: 无 output 时 text/tokens/costUsd 为 undefined（不抛错）", () => {
  const results = new Map([
    ["a", { runId: "r1", completed: true }], // 无 output 字段（如 gate 节点）
  ]);
  const upstream = buildUpstreamContext(results, ["a"]);
  assert.equal(upstream.a.text, undefined);
  assert.equal(upstream.a.tokens, undefined);
  assert.equal(upstream.a.costUsd, undefined);
  assert.equal(upstream.a.output, undefined);
});

test("buildUpstreamContext: output 部分缺字段时，别名只暴露存在的", () => {
  const results = new Map([
    ["a", { runId: "r1", completed: true, output: { text: "hi" } }], // 只有 text，无 tokens/costUsd
  ]);
  const upstream = buildUpstreamContext(results, ["a"]);
  assert.equal(upstream.a.text, "hi");
  assert.equal(upstream.a.tokens, undefined, "未设的 tokens 不出现");
  assert.equal(upstream.a.costUsd, undefined);
});

test("P0-F1 复现场景：下游 promptBuilder 用 ctx.upstream.research.text 直接拿调研文本（无需 collect/relay）", () => {
  // 决策 0010 融合项 #2 的核心承诺：coder 不用自己 collect researcher 的产出，
  // promptBuilder 直接 ctx.upstream.research.text 拿到。这是 P0-F1（人肉 relay）的引擎侧正解。
  const results = new Map([
    ["research", { runId: "r_research", completed: true, output: { text: "风险文件：auth.js, crypto.js" } }],
  ]);
  const upstream = buildUpstreamContext(results, ["research"]);
  const coderPrompt = `基于以下调研结果修复风险文件：${upstream.research.text}`;
  assert.ok(coderPrompt.includes("风险文件：auth.js, crypto.js"), "coder prompt 应自动含 researcher 文本（无需人肉 relay）");
});

// ===== checkRequiredClaims 测试 =====

test("checkRequiredClaims: 所有 claim 满足 → passed", () => {
  const node = { requiredClaims: ["a.text", "b.tokens"] };
  const upstream = {
    a: { output: { text: "hello" } },
    b: { output: { tokens: 10 } },
  };
  const { passed, missing } = checkRequiredClaims(node, upstream);
  assert.equal(passed, true);
  assert.deepEqual(missing, []);
});

test("checkRequiredClaims: 缺失 required claim → not passed + missing 列表", () => {
  const node = { requiredClaims: ["a.text", "b.tokens"] };
  const upstream = { a: { output: { text: "hello" } } }; // b 不存在
  const { passed, missing } = checkRequiredClaims(node, upstream);
  assert.equal(passed, false);
  assert.deepEqual(missing, ["b.tokens"]);
});

test("checkRequiredClaims: 裸字段（无 nodeId）在所有前驱里查找", () => {
  // 命中 → passed
  const hit = checkRequiredClaims({ requiredClaims: ["text"] }, { a: { output: { text: "hi" } } });
  assert.equal(hit.passed, true);
  assert.deepEqual(hit.missing, []);
  // 未命中 → missing
  const miss = checkRequiredClaims({ requiredClaims: ["missing"] }, { a: { output: { text: "hi" } } });
  assert.equal(miss.passed, false);
  assert.deepEqual(miss.missing, ["missing"]);
});
