# Agent 架构决策记录

> 状态：✅ 议题 1-4 讨论完毕，结论落盘。
> 日期：2026-06-16
> 背景：M6 完成后审视 worker 配置空白，引出主控-执行架构的四个议题。

## 架构总览

```
┌─────────────────────────────────────────────┐
│  主控 Lead（gpt/codex runtime）               │
│    与用户沟通、理解任务、编排、派发、验收、汇总 │
│  ← 人类（用户）是最终护栏，不加 LLM 护栏        │
│         ↑↓ 头脑风暴 / 方案评审 / 终审          │
│  副主控 Vice-Lead（claude/opus runtime）       │
│    主控的红队：方案阶段把关 + 交付前终审        │
└────────────────┬────────────────────────────┘
                 │ 动态编排（spawn / workflow run）
                 │ registry 里只有 worker（无 lead）
    ┌────────────┼────────────┐
    ▼            ▼            ▼
┌────────┐ ┌──────────┐ ┌──────────┐
│ coder  │ │ coder_   │ │researcher│
│ GLM-5.2│ │multimodal│ │DS-v4-    │
│        │ │Kimi K2.7 │ │flash     │
└────────┘ └──────────┘ └──────────┘
  [可选 runtime 特化 worker]
  coder_strict(claude) / tester(codex)
```

### 两个架构层次

- **主控层**：lead 用 gpt/codex，副主控用 claude/opus。它们是**调用方**，不进 registry。副主控配置（runtime/prompt 模式）属于 M7"多 Lead 协作"域。
- **worker 层**：全栈 opencode-serve（议题 4 结论）。可选 runtime 特化 worker（coder_strict=claude, tester=codex）偶尔降级使用。

## 议题 1：主控编排模式

**决策：主控自己编排，工具只提供原语。**

- 主控的编排能力来自 LLM 自身推理，不来自外部注入
- 不往 system prompt 灌编排逻辑（原则 #1）
- SKILL.md 只讲"原语怎么调"（spawn/run/collect/status/scorecard/workflow），不讲"什么时候串行/并行"——后者是主控的判断
- 项目 CLAUDE.md 讲"项目纪律"（测试必须过、文档要同步），不讲"怎么编排"

**原语清单（工具已提供）**：
spawn, run, status, tail, collect, stop, retry, resume, runs list/metrics/scorecard, workflow run

**编排的两个抽象层级**（共存）：
- 静态 workflow（M5）：人预先定义 .mjs，确定性编排，适合重复流程
- 主控动态编排：主控运行时决策，逐个 spawn 或生成 DAG

## 议题 2：副主控定位

**决策：副主控是独立议题，延后讨论。**

用户初步设想副主控在"方案阶段（任务理解+编排）"和"最终交付前"把关，类似主控的红队。但这涉及"多 Lead 协作"——属于 M7（无人值守）域，不在 worker 配置范围。

## 议题 3：多模型配置

**决策：coder 按模型能力分档（GLM-5.2 强编程 / Kimi K2.7 多模态略弱），同角色不同实例。researcher 用 DS-v4-flash（极低成本 + 1M context）。**

- worker 按角色命名（coder/researcher），不按 runtime 命名
- researcher 交付物透传 message 给主控（不写中间文件），省 token；完整推理在 transcript 里可追溯
- 配置形态：每个 worker 带 `_comment` 说明能力 + 适用任务

## 议题 4：runtime 选型

**决策：全栈 opencode-serve，无 trade-off。**

实测结论（见 research/07）：
- GLM-5.2 通过 opencode 调用 9 种工具（read/bash/grep/glob/write/todowrite/task/background_output/edit）完全可靠
- opencode tool part schema 比 claude-code/codex 表达力更强（自包含 input+output+status）
- TD-33（opencode 证据提取）可行性确认，优先级提升

**评分**：
| 维度 | opencode-serve | claude-code | codex |
|------|---------------|------------|-------|
| 工具调用 | ✅ 9 种 | ✅ Write/Edit/Bash | ✅ command_execution |
| 多模型 | ✅ GLM/Kimi/DS | ❌ 仅 claude | ❌ 仅 OpenAI |
| 会话复用 | ✅ HTTP | ❌ 进程死 | ❌ 进程死 |
| scorecard 证据 | 🟡 TD-33 待补 | ✅ M6-3 | ✅ M6-4 |
| 成本 | 低 | 高 | 中 |

**reasons 全栈 opencode 赢**：多模型是刚需（GLM-5.2/Kimi/DS 各有定位），会话复用是附赠。scorecard 对 opencode 暂缺（TD-33）但路径清晰且可补，不构成阻塞。

## 议题 1.5：DAG 编排模式

**决策：方案 C（预制 DAG + 动态生成 + DAG 库进化），两步走。**

- 第一步：预制几个典型 DAG 模板到 `workflows/`，参数式（agentId 不写死）
- 第二步（M7）：主控动态生成 DAG → 执行 → 沉淀成功 DAG 到库
- **参数式 DAG**：workflow 定义里用 `{{placeholder}}`，运行时 `--vars key=value` 注入
- 通用模板变量（不限于 agentId，prompt 里的变量也能替换）

## 原则重申

- **原则 #1 不变**：绝不往 agent system prompt 灌编排逻辑。主控的编排能力来自自身推理 + SKILL.md 的原语手册，不来自 prompt 注入
- **reviewer 由主控兼任**：验收需要全局上下文（任务是什么、交付物怎么汇总），只有主控有。scorecard 是程序级第一道筛（拦造假），主控是语义级第二道筛（判质量），纵深防御
- **人类是最终护栏**：不在工具层加 LLM 护栏（如防止无限循环），用户自己把控

## worker 角色定义（基于以上决策）

| 角色 | runtime | 模型 | 适合任务 | 交付物 |
|------|---------|------|---------|--------|
| coder | opencode-serve | GLM-5.2 | 编码/实现/重构/修 bug | 文件变更（scorecard 验证 file_written） |
| coder-multimodal | opencode-serve | Kimi K2.7 | 涉及图像/截图的编码任务 | 文件变更 |
| researcher | opencode-serve | DS-v4-flash | 调研/分析/文档 | message 透传主控（不写中间文件） |

**reviewer 不独立配置**——主控自己验收。

**副主控延后**——属于 M7 多 Lead 协作域。
