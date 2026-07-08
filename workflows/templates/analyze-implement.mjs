// 模板：分析 → 实现（串行，有依赖）
// researcher 先分析 → coder 根据分析结果实现。topic/output 用占位符，--vars 注入。
//
// 用法（按名字调用，TD-88 模板库）：
//   npm run cli -- workflow run analyze-implement \
//     --vars topic=isolation模块 --vars output=docs/isolation.md
//
// agentId 固定（researcher 分析 + coder_hq 实现）。要换 agent 直接改本文件副本。
export default {
  id: "template-analyze-implement",
  nodes: [
    {
      id: "analyze",
      type: "agent",
      agentId: "researcher",
      prompt: [
        "分析这个项目的 {{topic}}。",
        "只读边界：不得修改任何文件，不得安装依赖，不得改变环境。",
        "输出：三句话以内的核心设计总结 + 关键文件/函数清单。",
      ].join("\n"),
    },
    {
      id: "implement",
      type: "agent",
      agentId: "coder_hq",
      prompt: [
        "根据前序分析结果（见上游 runId/transcript），创建文件 {{output}}。",
        "写一份关于 {{topic}} 的简洁文档：模块职责、关键 API、使用示例。",
        "创建文件 {{output}} 后结束。",
      ].join("\n"),
      scorecard: { rules: { requireEvidence: true, requireFiles: ["{{output}}"] } },
    },
  ],
  edges: [
    { from: "analyze", to: "implement" },
  ],
};
