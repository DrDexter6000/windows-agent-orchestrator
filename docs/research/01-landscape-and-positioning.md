# 外部调研与定位

> 状态：🟡 调研材料已沉淀，定位方向已达成一致；细节仍可迭代。
> 调研日期：2026-06-15

## 1. 我们不是 LangGraph / CrewAI / AutoGen

这三类是 **agent framework**——它们实现的是 agent **内部**的推理循环（节点、状态机、对话、角色）。

我们做的是另一层：编排**已经存在、独立配置好的外部 agent runtime**（OpenCode serve，未来可能是 Claude Code、Codex）。这对应学术综述里的 **orchestration layer / control plane**，不是 agent framework。

| 维度 | Agent Framework（LangGraph 等） | 我们（orchestrator） |
|------|-------------------------------|---------------------|
| 管什么 | agent 内部推理 | agent 之上的调度、记录、编排 |
| 依赖谁 | 自己实现 LLM 调用 | 驱动外部 runtime |
| 替换难度 | 整个框架绑定 | runtime 可替换 |

**结论 ✅**：不和这些框架对标，它们不是我们的同类。

来源：[LangGraph vs CrewAI vs AutoGen 对比](https://www.meta-intelligence.tech/en/insight-ai-agent-frameworks)、[LangChain 多 agent 架构选择](https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture)

## 2. 我们的真正同类：本地 CLI 编排器

`awesome-agent-orchestrators` 收录了 80+ 个项目，共同特征：驱动 Claude Code / Codex / Gemini CLI / OpenCode，关注 git worktree 隔离、并行会话、kanban。

**关键空白（我们的生态位）🟡**：
- 几乎全是 macOS 原生 app 或 TUI
- **几乎没有 Windows 原生**
- **几乎没有 headless daemon 形态**
- 多数重度依赖 GUI 看板，无法被脚本 / CI 驱动

来源：[awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)、[Architect（headless CLI 编排）](https://www.reddit.com/r/vibecoding/comments/1rgj52j/architect_an_opensource_cli_to_orchestrate/)

## 3. 学术框架：编排层的四个组件

arXiv 综述把编排层拆成四个职责清晰的子系统，这是个干净的参照骨架：

| 组件 | 职责 | 我们的对应层 |
|------|------|-------------|
| Execution & Control | 运行注册表、生命周期、调度 | L2 控制平面 |
| Planning & Policy | 工作流、依赖、检查点 | L3 编排层 |
| State & Knowledge | 状态持久化、共享黑板 | L1 Transcript |
| Quality & Ops | 可观测、metrics | 横切可观测性 |

来源：[The Orchestration of Multi-Agent Systems（arXiv 综述）](https://arxiv.org/html/2601.13671v1)

## 4. Anthropic 实战经验（两条直接可用）

Anthropic 多 agent 研究系统的工程笔记里有两条经验直接影响我们的设计：

1. **子代理产出直接落文件系统，只回传引用**——避免"传话游戏"丢失信息，避免 token 爆炸。我们的 transcript 设计天然契合。
2. **状态必须持久化 + 可从断点恢复**——"重启很贵"。我们已有 JSONL transcript，是对的方向。
3. （补充）token 成本是单 agent 的 **15 倍**——编排不是免费午餐，可观测性里必须有成本维度。

来源：[How we built our multi-agent research system（Anthropic）](https://www.anthropic.com/engineering/multi-agent-research-system)

## 5. 编排模式词汇（Azure / LangChain）

可作为未来 L3 编排层的"模式菜单"：

- Sequential / Linear（顺序流水线）
- Parallel / Concurrent（并行）
- Hierarchical / Supervisor（中心化调度）
- Router / Handoff（动态路由）
- Blackboard（共享黑板——我们的 transcript 就是）
- Mesh / Adaptive（去中心化）

来源：[Azure AI Agent 编排模式](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)、[Confluent 事件驱动多 agent](https://www.confluent.io/blog/event-driven-multi-agent-systems/)

## 6. 一句话定位 ✅

> **Windows 原生、headless、runtime-agnostic 的本地 agent runtime 控制平面。**

三个关键词每个都在做减法：

| 关键词 | 含义 | 刻意不做 |
|--------|------|----------|
| Windows 原生 | Node ESM，无 Docker/WSL 依赖，PowerShell 友好 | 跨平台 TUI、Electron GUI |
| headless | daemon + CLI，可被脚本/CI 驱动 | kanban 看板、手机 dashboard |
| runtime-agnostic | 统一抽象屏蔽 runtime 差异 | 实现 agent 内部推理、自己做 LLM 调用 |
