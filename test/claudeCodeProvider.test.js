// test/claudeCodeProvider.test.js
//
// P4 融合项 #3（决策B 全量迁移）：claude-code backend 从 provider 一等字段推导参数。
//
// 决策 0010：model/provider/effort/apiKeyEnv 提为一等字段，消除配置藏在 args/prependArgs
// 数组里导致的漂移（opus-4.8 bug：同一 model 出现在 wrapper prependArgs 的 --default-model
// 和 claude CLI args 的 --model 两处，易不一致）。正解：单一真相源 provider 字段，backend 推导
// 出 wrapper 参数 + CLI flag——两处从同一字段生成，物理上不可能漂移。
//
// 纯函数 resolveProviderArgs(agent) 可单测：返回 wrapper prependArgs 数组（含 --base-url/
// --api-key-env/--default-model/--effort/--context-window/--）+ 推导的 claude CLI flags
// （--model/--effort）。无 provider 时返回 null（向后兼容，走旧 agent.prependArgs/args）。

import test from "node:test";
import assert from "node:assert/strict";
import { resolveProviderArgs } from "../src/backends/claudeCodeProvider.js";

const WRAPPER_PLACEHOLDER = "WRAPPER_PATH_PLACEHOLDER";

test("resolveProviderArgs: 完整 provider → wrapper prependArgs + claude CLI flags", () => {
  const agent = {
    id: "coder",
    provider: {
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKeyEnv: "ZHIPU_API_KEY",
      model: "glm-5.2",
      effort: "high",
      contextWindow: 1000000,
    },
  };
  const { prependArgs, cliFlags } = resolveProviderArgs(agent, WRAPPER_PLACEHOLDER);
  // wrapper 参数：wrapper 路径 + base-url/api-key-env/default-model/effort/context-window + --
  assert.equal(prependArgs[0], WRAPPER_PLACEHOLDER, "首项是 wrapper 路径");
  assert.ok(prependArgs.includes("--base-url"), "含 --base-url");
  assert.ok(prependArgs.includes("--api-key-env"), "含 --api-key-env");
  assert.ok(prependArgs.includes("--default-model"), "含 --default-model");
  assert.ok(prependArgs.includes("--effort"), "含 --effort");
  assert.ok(prependArgs.includes("--context-window"), "含 --context-window");
  assert.equal(prependArgs.at(-1), "--", "末项是 -- 分隔符");
  // 值正确
  assert.equal(prependArgs[prependArgs.indexOf("--base-url") + 1], "https://open.bigmodel.cn/api/anthropic");
  assert.equal(prependArgs[prependArgs.indexOf("--api-key-env") + 1], "ZHIPU_API_KEY");
  assert.equal(prependArgs[prependArgs.indexOf("--default-model") + 1], "glm-5.2");
  assert.equal(prependArgs[prependArgs.indexOf("--effort") + 1], "high");
  assert.equal(prependArgs[prependArgs.indexOf("--context-window") + 1], "1000000");
  // claude CLI flags：--model + --effort，与 wrapper 同源（单一真相源，防漂移）
  assert.deepEqual(cliFlags, ["--model", "glm-5.2", "--effort", "high"]);
});

test("resolveProviderArgs: 无 effort/contextWindow → 不生成对应 flag", () => {
  const agent = {
    provider: { baseUrl: "https://x", apiKeyEnv: "KEY", model: "m" },
  };
  const { prependArgs, cliFlags } = resolveProviderArgs(agent, WRAPPER_PLACEHOLDER);
  assert.ok(!prependArgs.includes("--effort"), "无 effort → wrapper 不含 --effort");
  assert.ok(!prependArgs.includes("--context-window"), "无 contextWindow → wrapper 不含 --context-window");
  assert.deepEqual(cliFlags, ["--model", "m"], "无 effort → CLI 只 --model");
});

test("resolveProviderArgs: 无 provider → 返回 null（向后兼容旧形态）", () => {
  const agent = { id: "coder" }; // 无 provider
  const result = resolveProviderArgs(agent, WRAPPER_PLACEHOLDER);
  assert.equal(result, null, "无 provider = 走旧 agent.prependArgs/args，不推导");
});

test("resolveProviderArgs: model 是单一真相源——wrapper --default-model 与 CLI --model 同值", () => {
  // 这是决策B 的核心承诺：opus-4.8 bug 是 model 两处不一致。两处从同一字段来 = 不可能漂移。
  const agent = { provider: { baseUrl: "https://x", apiKeyEnv: "K", model: "glm-5.2", effort: "high" } };
  const { prependArgs, cliFlags } = resolveProviderArgs(agent, WRAPPER_PLACEHOLDER);
  const wrapperModel = prependArgs[prependArgs.indexOf("--default-model") + 1];
  const cliModel = cliFlags[cliFlags.indexOf("--model") + 1];
  assert.equal(wrapperModel, cliModel, "wrapper 与 CLI 的 model 必须同值（单一真相源）");
  assert.equal(wrapperModel, "glm-5.2");
});

test("resolveProviderArgs: effort 同样是单一真相源（wrapper 与 CLI 同值）", () => {
  const agent = { provider: { baseUrl: "https://x", apiKeyEnv: "K", model: "m", effort: "high" } };
  const { prependArgs, cliFlags } = resolveProviderArgs(agent, WRAPPER_PLACEHOLDER);
  const wrapperEffort = prependArgs[prependArgs.indexOf("--effort") + 1];
  const cliEffort = cliFlags[cliFlags.indexOf("--effort") + 1];
  assert.equal(wrapperEffort, cliEffort, "wrapper 与 CLI 的 effort 必须同值");
  assert.equal(wrapperEffort, "high");
});
