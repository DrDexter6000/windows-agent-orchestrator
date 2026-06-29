# Onboarding 设计思路

> 状态：✅ 已落地。
> 日期：2026-06-16
> 背景：M4 完成后，工具已具备完整能力（多 runtime + 隔离 + 恢复 + 可观测），但 Lead Agent 不知道怎么用它。

## 问题

M0–M4 写了 6+ 份文档，全是给人看的。一个新 Lead Agent（claude code / codex）第一次接触项目时：
- 它读 `AGENTS.md`——但那份还停留在 PoC 初始状态，没更新
- 它不会自动读 `docs/`
- 它不知道有 `spawn`/`run`/`resume`/`runs metrics` 命令

**这正是 RunMaestro 崩溃的根因之一**——编排信息没有结构化方式传达给 agent，最后全灌 system prompt，三源冲突。

## 核心张力与解法

### 张力：agent 需要知道怎么用工具，但我们不能把编排逻辑灌进 system prompt

RunMaestro 的教训 + 我们的原则 #2："绝不往 agent system prompt 灌指令"。

但 Lead Agent 确实需要知道怎么用 CLI——否则它只会傻傻 `claude -p "..."`。

### 解法：三层分离

| 层 | 内容 | 载体 | 谁负责 |
|----|------|------|--------|
| 工具使用层 | 怎么调 spawn/run/resume | `SKILL.md`（项目根） | 我们（工具作者）|
| 项目治理层 | 项目开发纪律 | 项目的 CLAUDE.md | 用户（项目所有者）|
| 编排逻辑层 | 状态机/DAG/scorecard | 代码（RunManager） | 代码（确定性）|

**关键边界**：
- ✅ 传达"工具怎么用"（命令语法、workflow）——这是工具使用说明
- ❌ 不传达"怎么编排"（编排逻辑活在代码里）
- ❌ 不传达"项目纪律"（那是项目自己的事）

Lead Agent 读 SKILL.md 拿到工具使用说明，读项目的 CLAUDE.md 拿到项目治理，编排逻辑它永远不碰。三层不交叉，不冲突。

## 载体选择

### 调研结论

Claude Code 的 skill 机制：`.claude/skills/<name>/SKILL.md` 自动发现，YAML frontmatter 的 `description` 是触发器（Claude 用它判断何时调用），body 按需加载（progressive disclosure）。

来源：[Claude Code skills 官方文档](https://code.claude.com/docs/en/skills)、[Anthropic skill 最佳实践](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)

### 决策：放项目根的 SKILL.md，不放 .claude/skills/

**最初我放到了 `.claude/skills/wao-orchestrator/SKILL.md`——这是错的。** 理由：
- `.claude/skills/` 是 Claude Code 私有路径，绑死了 runtime
- 违反 runtime-agnostic 原则——codex/opencode 不会读这个路径
- 单文件不该套两层目录（`skills/wao-orchestrator/SKILL.md`）

**最终决策**：SKILL.md 放项目根。理由：
1. 项目根是所有 runtime 都认可的中立位置
2. AGENTS.md（所有 runtime 自动读）指向它，agent 知道去读
3. 单文件不需要目录嵌套
4. Claude Code 虽然不自动发现根目录的 SKILL.md，但 AGENTS.md 的指针让 agent 主动去读——效果一样

**与终局不冲突**：skill 是"工具使用说明"（策略层），编排逻辑在代码里（控制层）。M5 的 workflow YAML 是"怎么编排任务"，SKILL.md 是"怎么用编排工具"。

## 文档结构

```
项目根/
├── AGENTS.md      ← 薄入口：项目是什么 + 5 条原则 + 指向 SKILL.md
├── SKILL.md       ← 完整手册：命令/workflow/config/transcript/限制
├── docs/          ← 深度文档（按需读）
```

### AGENTS.md 的职责（薄）

- 项目一句话描述
- 5 条核心原则（不 violate）
- 指针："需要用工具 → 读 SKILL.md；需要改代码 → 读 docs/"
- 项目结构概览
- 编码风格 + 约束

**故意不包含命令详情**——那在 SKILL.md 里。AGENTS.md 保持精简，减少 agent 常驻 context 负担。

### SKILL.md 的职责（完整）

- YAML frontmatter：`name` + `description`（description 含触发词，让 agent 知道何时用）
- 命令速查（全部命令）
- 标准 workflow（4 个场景）
- registry 配置详解
- transcript 格式
- 被脚本/LLM 驱动的模式
- 当前限制（诚实标注）
- 深度文档指针

## 验证

真实 claude code 验证了 onboarding 链路：
1. 读 AGENTS.md → 找到 SKILL.md 指针
2. 读 SKILL.md → 正确回答"spawn 命令 + runs metrics 命令"
3. 知道 transcript 在 `runs/<runId>.jsonl`，格式是 JSONL

**验证的不是"agent 能不能跑通"（那是 smoke 的事），而是"agent 能不能自主发现并理解工具用法"**。这是 onboarding 的核心。

## 经验沉淀

1. **文档要分受众**：给人看的（docs/，详细推理过程）和给 agent 看的（AGENTS.md/SKILL.md，精炼可执行）。混在一起 = 两边都不好用。
2. **载体中立**：工具说明不能放在某个 runtime 的私有路径。项目根是最通用的。
3. **progressive disclosure**：AGENTS.md 薄（入口），SKILL.md 完整（手册），docs/ 深度（按需）。三层递进，不一次性灌全部。
4. **诚实标注限制**：SKILL.md 明确写了"无 daemon""无 DAG""无 scorecard"——agent 不会对能力产生错误预期。
