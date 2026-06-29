import { buildPrompt, buildUpstreamContext, checkRequiredClaims } from "./handoff.js";

/**
 * 节点 handler 注册表（M5-3）。
 *
 * 三种内置类型：agent / gate / router。
 * 用户可注册自定义：registerHandler("custom", MyHandler)。
 *
 * handler 不直接调 backend（通过 RunManager）。
 */

/**
 * @typedef {Object} NodeResult
 * @property {string} [runId]
 * @property {string} [transcriptPath]
 * @property {boolean} completed
 * @property {Array} [messages]
 * @property {object} [metrics]
 * @property {object} [output]  - 节点产出（供 gate 检查 + 下游引用）
 * @property {string[]} [routes] - router 选择的下游 node id
 */

/**
 * @typedef {Object} NodeContext
 * @property {object} runManager
 * @property {object} upstream - 前驱节点结果（引用传递）
 * @property {string} [input] - workflow 级输入
 * @property {object} [options]
 */

// ===== 内置 handler =====

/** agent 节点：调 RunManager.start + waitForCompletion */
const agentHandler = {
  async execute(node, ctx) {
    const prompt = buildPrompt(node, ctx);
    const run = await ctx.runManager.start(node.agentId, {
      prompt,
      isolate: ctx.options?.isolate,
      // C1 修复（审计 P1-a）：节点级 scorecard 配置传给 RunManager。
      // 之前遗漏 → workflow 里配的 node.scorecard 静默失效。
      // resolveScorecardRules 优先级：options.scorecard > agent.scorecard > null。
      ...(node.scorecard ? { scorecard: node.scorecard } : {}),
      ...ctx.options,
    });
    const waitResult = await run.waitForCompletion(ctx.options ?? {});
    return {
      runId: run.runId,
      transcriptPath: run.transcript.filePath,
      completed: waitResult.completed,
      messages: waitResult.messages,
      metrics: waitResult.metrics,
      output: extractOutput(waitResult),
    };
  },
};

/** gate 节点：检查前驱 completed + requiredClaims */
const gateHandler = {
  async execute(node, ctx) {
    // 检查前驱是否都 completed
    const failedPredecessors = Object.entries(ctx.upstream)
      .filter(([, r]) => !r.completed)
      .map(([id]) => id);
    if (failedPredecessors.length > 0) {
      return {
        completed: false,
        output: { gatePassed: false, reason: `predecessors not completed: ${failedPredecessors.join(", ")}` },
      };
    }
    // 检查 requiredClaims
    const { passed, missing } = checkRequiredClaims(node, ctx.upstream);
    return {
      completed: passed,
      output: { gatePassed: passed, ...(missing.length > 0 ? { missing } : {}) },
    };
  },
};

/** router 节点：根据 routes 函数选择下游路径 */
const routerHandler = {
  async execute(node, ctx) {
    if (typeof node.routes !== "function") {
      throw new Error(`router node "${node.id}" missing routes function`);
    }
    const selected = node.routes(ctx);
    const routes = Array.isArray(selected) ? selected : [selected];
    return {
      completed: true,
      routes,
      output: { selectedRoutes: routes },
    };
  },
};

/**
 * integrator 节点（M8-5）：收集所有前驱 output.text，去重+按拓扑序拼成初稿（🔵 工具起草域）。
 *
 * 设计：拼了初稿就算 completed，但不判定交付质量——必须由后续 gate/agent 节点或
 * Lead 读取 draft 后人工终验。不自动跑"完整性 gate"（用户否决自动 gate）。
 *
 * 拼好的 draft 进 output，通过 ctx.upstream 可被下游引用（同 agent 节点链式机制）。
 * 支持 node.template 字段控制拼接格式（默认顺序拼接，每段间 \n\n 分隔）。
 */
const integratorHandler = {
  async execute(node, ctx) {
    const upstream = ctx.upstream ?? {};
    // 按前驱 id 顺序收集文本（保持拓扑序），去重（精确字符串去重）。
    const seen = new Set();
    const sources = [];
    const segments = [];
    for (const [nodeId, res] of Object.entries(upstream)) {
      const text = res?.text ?? res?.output?.text;
      if (typeof text !== "string" || text.length === 0) continue;
      sources.push(nodeId);
      if (seen.has(text)) continue; // 精确去重
      seen.add(text);
      segments.push(text);
    }
    const sep = node.template?.separator ?? "\n\n";
    const draft = segments.join(sep);
    return {
      completed: true,
      output: {
        draft,
        sources,
        ...(segments.length === 0 ? { empty: true } : {}),
      },
    };
  },
};

// ===== 注册表 =====

const handlers = new Map([
  ["agent", agentHandler],
  ["gate", gateHandler],
  ["router", routerHandler],
  ["integrator", integratorHandler],
]);

export function registerHandler(type, handler) {
  if (!handler || typeof handler.execute !== "function") {
    throw new Error(`registerHandler: handler must have execute(node, ctx) method`);
  }
  handlers.set(type, handler);
}

export function getHandler(type) {
  const handler = handlers.get(type);
  if (!handler) {
    throw new Error(`getHandler: unknown node type "${type}". Register with registerHandler().`);
  }
  return handler;
}

/** 从 waitResult 提取 agent 产出（供 gate 检查 + 下游引用） */
function extractOutput(waitResult) {
  // M5 简化：output 从 assistant 消息文本提取
  const assistantText = (waitResult.messages ?? [])
    .filter((m) => m.info?.role === "assistant")
    .flatMap((m) => (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text))
    .join("\n");
  return {
    text: assistantText,
    tokens: waitResult.metrics?.tokens,
    costUsd: waitResult.metrics?.costUsd,
  };
}

export { agentHandler, gateHandler, routerHandler, integratorHandler };
