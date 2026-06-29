// src/backends/claudeCodeProvider.js
//
// P4 融合项 #3（决策B 全量迁移）：claude-code provider 一等字段 → 参数推导。
//
// 决策 0010：model/provider/effort/apiKeyEnv 提为一等字段，消除配置藏在 args/prependArgs
// 数组里导致的漂移。opus-4.8 bug 的温床：同一 model 出现在 (a) claude-code-provider-wrapper
// 的 prependArgs --default-model 和 (b) claude CLI args 的 --model 两处，易不一致。
//
// 正解（决策B）：单一真相源 provider 字段，本模块从它推导两套参数——
//   - wrapper prependArgs（--base-url/--api-key-env/--default-model/--effort/--context-window/--）
//   - claude CLI flags（--model/--effort）
// 两处从同一字段生成，物理上不可能漂移。
//
// 设计：纯函数，无 IO。wrapper 路径由调用方注入（claudeCode.js 用 __dirname 推导，测试注入占位）。
// 无 provider 时返回 null（向后兼容：走旧 agent.prependArgs/args，不破坏既有 agents.json）。
//
// 纪律：本模块不 spawn（那是 processBackend 的事），只做参数推导（可单测）。

/**
 * 从 agent.provider 一等字段推导 claude-code 参数。
 * @param {object} agent - registry agent（含 provider 字段）
 * @param {string} wrapperPath - claude-code-provider-wrapper.mjs 的绝对路径（由调用方注入）
 * @returns {{prependArgs: string[], cliFlags: string[]}|null}
 *   - prependArgs: wrapper 参数（含 wrapper 路径 + provider flags + -- 分隔符）
 *   - cliFlags: claude CLI 的 --model/--effort（与 wrapper 同源）
 *   - null: agent 无 provider（向后兼容，调用方走旧 agent.prependArgs/args）
 */
export function resolveProviderArgs(agent, wrapperPath) {
  const provider = agent?.provider;
  if (!provider) return null;
  if (!wrapperPath) throw new Error("resolveProviderArgs: wrapperPath required (when provider present)");

  const prependArgs = [wrapperPath];
  if (provider.baseUrl) prependArgs.push("--base-url", provider.baseUrl);
  if (provider.apiKeyEnv) prependArgs.push("--api-key-env", provider.apiKeyEnv);
  if (provider.model) prependArgs.push("--default-model", provider.model);
  if (provider.effort) prependArgs.push("--effort", provider.effort);
  if (provider.contextWindow) prependArgs.push("--context-window", String(provider.contextWindow));
  // wrapper 与 claude CLI 的分隔符（wrapper 后面接 claude 的 passthrough args）
  prependArgs.push("--");

  // claude CLI flags：与 wrapper 同源（单一真相源，防漂移）。
  // model/effort 同时给 wrapper（设置 env）和 claude CLI（显式 flag），两处一致。
  const cliFlags = [];
  if (provider.model) cliFlags.push("--model", provider.model);
  if (provider.effort) cliFlags.push("--effort", provider.effort);

  return { prependArgs, cliFlags };
}
