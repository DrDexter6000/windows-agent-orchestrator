// 参数式 DAG 模板：分析 → 实现（串行，有依赖）
// agentId 和 prompt 都用占位符，运行时 --vars 注入
//
// 用法：
//   workflow run workflows/param-analyze-implement.mjs \
//     --vars researcher=researcher --vars coder=coder \
//     --vars topic=isolation模块 --vars output=docs/param-test.md
export default {
  id: "param-analyze-implement",
  nodes: [
    {
      id: "analyze",
      type: "agent",
      agentId: "{{researcher}}",
      prompt: "分析这个项目的 {{topic}}，用三句话总结它的核心设计和用法。不要修改任何文件。",
    },
    {
      id: "document",
      type: "agent",
      agentId: "{{coder}}",
      prompt: "根据前序分析结果，创建文件 {{output}}，写一份关于 {{topic}} 的简洁文档。",
    },
  ],
  edges: [
    { from: "analyze", to: "document" },
  ],
};
