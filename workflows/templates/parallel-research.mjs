// 模板：并行研究（2 路 researcher 各研究一个主题，无边 = 同层并行）
// 适合"对比两个模块/方案/文件"这类需要独立视角再汇总的任务。
//
// 用法（按名字调用，TD-88 模板库）：
//   npm run cli -- workflow run parallel-research \
//     --vars topicA=claudeCode-backend --vars topicB=kimiCode-backend
//
// 两路都固定用 researcher（只读分析）。结果在各自 runId 的 transcript 里，Lead 自行汇总。
export default {
  id: "template-parallel-research",
  nodes: [
    {
      id: "research_a",
      type: "agent",
      agentId: "researcher",
      prompt: [
        "深入研究项目的 {{topicA}}。",
        "只读边界：不得修改任何文件，不得安装依赖，不得改变环境。",
        "输出：这个主题的核心设计、关键代码位置（带行号）、能力与局限。",
      ].join("\n"),
    },
    {
      id: "research_b",
      type: "agent",
      agentId: "researcher",
      prompt: [
        "深入研究项目的 {{topicB}}。",
        "只读边界：不得修改任何文件，不得安装依赖，不得改变环境。",
        "输出：这个主题的核心设计、关键代码位置（带行号）、能力与局限。",
      ].join("\n"),
    },
  ],
  edges: [],
};
