// 示例 workflow：2 节点串行（analyze → summarize）
// 用同一个 claude_worker agent，第二次调用的 prompt 引用第一次的 runId
// F4：worker 节点默认带最小 scorecard（requireEvidence:true），让验收默认生效——
// 不配 scorecard 时验收退化为纯语义判断，容易放过伪完成。
export default {
  id: "analyze-summarize",
  nodes: [
    {
      id: "analyze",
      type: "agent",
      agentId: "claude_worker",
      prompt: "Analyze this project structure in 2 sentences. Be concise.",
      scorecard: { rules: { requireEvidence: true } },
    },
    {
      id: "summarize",
      type: "agent",
      agentId: "claude_worker",
      promptBuilder: (ctx) =>
        `Based on analysis run ${ctx.upstream.analyze?.runId}, write a one-line summary.`,
      scorecard: { rules: { requireEvidence: true } },
    },
  ],
  edges: [
    { from: "analyze", to: "summarize" },
  ],
};
