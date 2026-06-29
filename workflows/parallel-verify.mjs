// 端到端验证 workflow：researcher + coder 并行（无依赖）
// - researcher (DeepSeek, first-stable): 分析 PoC 的架构分层，输出总结
// - coder (GLM-5.2, snapshot-stable): 给 isolation.js 写使用文档
// 两个节点无边 = 同层 = 并行执行
export default {
  id: "parallel-verify",
  nodes: [
    {
      id: "arch_analysis",
      type: "agent",
      agentId: "researcher",
      prompt: "分析这个项目的架构分层。读取 src/ 目录结构，总结这个项目分几层、每层职责。输出格式：分层列表 + 一句话总结。不要修改任何文件。",
    },
    {
      id: "isolation_doc",
      type: "agent",
      agentId: "coder",
      prompt: "读取 src/isolation.js，理解它的 API（createWorktree/removeWorktree/listWorktrees），然后创建文件 docs/isolation.md，写一份简洁的中文使用说明（模块职责、API 说明含参数返回值、使用示例）。",
      // F4：写文件的 worker 默认带 scorecard——验证文件真生成 + 有证据，防伪完成。
      scorecard: { rules: { requireEvidence: true, requireFiles: ["docs/isolation.md"] } },
    },
  ],
  edges: [],
};
