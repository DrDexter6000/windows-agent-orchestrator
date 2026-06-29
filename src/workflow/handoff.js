/**
 * 节点间数据传递（M5-5）。
 *
 * 核心原则：传引用不传内容（Anthropic 经验，防 token 爆炸）。
 * ctx.upstream 包含前驱节点的 runId/transcriptPath，不包含 messages 全文。
 */

/**
 * 构造节点的 prompt。
 * @param {object} node 节点定义
 * @param {object} ctx 执行上下文（含 upstream）
 * @returns {string} prompt 文本
 */
export function buildPrompt(node, ctx) {
  if (typeof node.promptBuilder === "function") {
    const prompt = node.promptBuilder(ctx);
    if (typeof prompt !== "string") {
      throw new Error(`promptBuilder of node "${node.id}" must return a string`);
    }
    return prompt;
  }
  if (typeof node.prompt === "string") {
    return node.prompt;
  }
  throw new Error(`node "${node.id}" has no prompt or promptBuilder`);
}

/**
 * 构造 upstream 上下文（传引用不传内容）。
 * @param {Map<string, NodeResult>} completedResults 已完成节点的结果
 * @param {string[]} predecessorIds 当前节点的前驱 node id
 * @returns {object} ctx.upstream { [nodeId]: {runId, transcriptPath, completed, output, text, tokens, costUsd} }
 *
 * P4 融合项 #2（决策 0010）：除 output 结构外，暴露一等别名 text/tokens/costUsd
 * 直接挂在 upstream[id] 上——让声明式链式 = 手动链式一样简单：下游 promptBuilder 用
 * `ctx.upstream.research.text` 直接拿前驱文本，无需 collect/relay（解 P0-F1 人肉消息总线）。
 * output 结构保留（向后兼容 + gate 的 checkRequiredClaims 用 output.field 查找）。
 */
export function buildUpstreamContext(completedResults, predecessorIds) {
  const upstream = {};
  for (const id of predecessorIds) {
    const result = completedResults.get(id);
    if (result) {
      upstream[id] = {
        runId: result.runId,
        transcriptPath: result.transcriptPath,
        completed: result.completed,
        output: result.output,
        // P4 决策 0010 一等别名：output.text/tokens/costUsd 直接可达（无 output 时不抛错，为 undefined）。
        text: result.output?.text,
        tokens: result.output?.tokens,
        costUsd: result.output?.costUsd,
      };
    }
  }
  return upstream;
}

/**
 * 检查 gate 的 requiredClaims。
 * @param {object} node gate 节点定义（含 requiredClaims）
 * @param {object} upstream 前驱上下文
 * @returns {{passed: boolean, missing: string[]}}
 */
export function checkRequiredClaims(node, upstream) {
  const required = node.requiredClaims ?? [];
  const missing = [];
  // requiredClaims 格式："nodeId.field" 或 "field"（查所有前驱）
  for (const claim of required) {
    const [nodeId, field] = claim.includes(".") ? claim.split(".", 2) : [null, claim];
    let found = false;
    if (nodeId) {
      found = upstream[nodeId]?.output?.[field] !== undefined;
    } else {
      found = Object.values(upstream).some((r) => r?.output?.[field] !== undefined);
    }
    if (!found) missing.push(claim);
  }
  return { passed: missing.length === 0, missing };
}
