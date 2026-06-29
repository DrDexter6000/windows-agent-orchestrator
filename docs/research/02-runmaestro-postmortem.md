# RunMaestro 崩溃案例剖析

> 状态：✅ 案例事实已沉淀；🟡 诊断修正已和用户对齐。
> 这是驱动整个架构思考的**实战锚点**，比任何理论都有分量。

## 0. 背景（用户实战陈述）

用户长期使用 RunMaestro 协调多个 agent-runtime（opencode / codex / claude code）协作开发 life index 项目。
升级后整个工作流彻底崩溃——主控 Agent 完全无法调度 worker agent，调度链条瘫痪。
用户描述的三个压力源：

1. Maestro 本身 workflow 架构很重、大量 system prompt
2. 兼容的 runtime（opencode / codex / claude code）经常升级、带来变量
3. life index 项目本身有自主的开发 governance 和工作纪律

三项经常全量灌给主控 Agent，灌爆心智；三项之间偶尔冲突矛盾。

## 1. 仓库调研（两份 subagent 报告）

调研目标：确认 RunMaestro 的"重"到底重在哪一层（原语层 vs 策略层）。

### 关键事实

- **`Maestro-Playbooks` 是纯 Markdown 仓库，零代码**。没有 `src/`、没有引擎、没有 `.yaml/.json` schema（除 manifest）。
- **真正的引擎在闭源 `RunMaestro/Maestro` 桌面 app**，是 GUI，行为黑盒，不可审计、不可控。
- 典型 playbook 结构：`Agent-Prompt.md`（主控人格）+ `N_*.md`（带编号的阶段任务）+ `5_PROGRESS.md`（进度门控模板）。
- 文件式状态传递：`LOOP_N_COVERAGE_REPORT.md` / `LOOP_N_GAPS.md` 等中间文件在阶段间传递。
- **唯一明确引用的 runtime 是 Claude Code**（出现 `.claude/agents`、`.claude/commands`、`Task` 工具、`/research` slash command）。仓库内无 opencode / codex 集成证据。

### 报告间的分歧（重要）

两个 subagent 在"重不重"上有分歧，这个分歧本身是教训：

| | Agent 1 | Agent 2（更精确） |
|---|---------|------------------|
| 判断 | 重，主要是策略层重 | 单 playbook 其实不大（~5–6k tokens） |
| 状态机归属 | 写进 prompt 让 LLM 自执行 | loop/reset/排序是**引擎**做的，markdown 只是"描述" |

**Agent 2 的修正性发现**：`manifest.json` 含 `loopEnabled` / `maxLoops` / `resetOnCompletion`，说明真正的 loop 控制在 Maestro app 引擎里。`5_PROGRESS.md` 的"coverage ≥ 80% 则 exit"是**描述**门控逻辑，但**判定执行**可能在引擎 + LLM 之间灰色地带。

**未知黑盒**：Maestro 的**默认 agent prompt 不在仓库里**，体量未知。这本身是脆弱性——你的命运绑在一个不可控的闭源 prompt 上。

## 2. 诊断的修正过程

### 用户原始直觉

> "大量 system prompt 灌爆了主控 agent 的心智"

### 调研后的修正

证据在"量"这个维度上**不如预期强**——单 playbook ~5–6k token 并不夸张。

**真正的病不是体量，是结构。** 崩溃的真正机理是：

```
三源 system prompt 同时进主控 agent 的脑子：
  ① Maestro 的 playbook 指令（任务 + 伪状态机 + 门控）
  ② runtime 自己的 system prompt（CLAUDE.md / opencode agent 定义）
  ③ life index 的项目 governance

这三个来源有三个致命特征：
  - 独立演进、无人协调（Maestro 升级、runtime 升级、项目改 governance，互不通知）
  - 没有仲裁者（冲突时没有任何代码层裁决，LLM 在脑子里仲裁，行为不可预测）
  - 状态机被外包给 LLM（门控判定"是否达标/要不要回退"由 LLM 做，一旦误判就漂移卡死）
```

**"主控完全无法调度"不是 prompt 太长压垮 LLM，是把 LLM 放到了它扛不住的角色上：同时做执行者 + 调度器 + 进度仲裁 + 三方冲突法官。** 这不是能力问题，是角色设计错误——任何 LLM 都扛不住，不管多强。

## 3. 由此导出的架构原则 ✅

这些原则是**直接从 RunMaestro 的坑里倒推出来的**，不是纯理论：

### 原则 1：确定性逻辑绝不外包给 LLM

状态机、门控判定、阶段流转、冲突仲裁——这些一旦写成 prompt 让 LLM 自执行，系统注定脆弱。
**该薄的不是"代码量"，是"交给 LLM 的决策量"。**
状态机这种东西，宁可做成死板的、确定性的、甚至丑一点的代码，也不要让 LLM 去"理解并执行"它。

### 原则 2：我们的工具绝不往 agent 的 system prompt 里灌指令（铁律）

这是 RunMaestro 最深的坑——它把"如何编排"写进了被编排 agent 的脑子里，于是编排逻辑和 agent 自身的 prompt 体系直接冲突，且无解。

我们的做法相反：**编排逻辑活在 transcript 事件 + 确定性状态机里，agent 只看到一个普通的 task prompt。**
agent 不知道"自己在被编排"，它只看到"有人给了我一个任务"。

这样三源冲突的根子——"三方都往 system prompt 里塞东西"——从架构上被消除：
- runtime 自己的 system prompt（CLAUDE.md 等）原封不动，我们不侵入
- 项目 governance 原封不动，活在 agent 的项目目录里
- 我们的编排层活在 agent **之外**，是透明代理，不是大脑植入

### 原则 3：该确定的确定，该灵活的灵活（双重修正）

RunMaestro 的双重错误：
- ❌ 该确定的没确定（状态机外包给 LLM）
- ❌ 该灵活的没灵活（连"怎么写测试""怎么重构"这种领域判断也写成死 checkbox 让 LLM 逐条勾）

我们的方向：
- ✅ 状态流转、门控、冲突仲裁 → 做成薄而硬的确定性代码
- ✅ 任务怎么拆、领域怎么处理 → **最大化留给 LLM**，不用 playbook 绑死

## 4. 待确认 ❓

- 用户体感的"很臃肿"，源头是否是 **Maestro 闭源默认 prompt + 三方叠加**后的总量，而非单 playbook？这影响文档里怎么描述"体量"这个维度。（已向用户提问，待回复。）

## 5. 引用来源

- [RunMaestro/Maestro-Playbooks](https://github.com/RunMaestro/Maestro-Playbooks)（纯 markdown 仓库）
- [RunMaestro/Maestro](https://github.com/RunMaestro/Maestro)（闭源引擎，桌面 app）
- [官方文档 Auto Run + Playbooks](https://docs.runmaestro.ai/autorun-playbooks)
- 关键文件证据：`manifest.json`（含 loop/reset 元数据）、`Development/Testing/5_PROGRESS.md`（~90% 编排逻辑 / ~10% 领域内容）、`Research/Market`（唯一自定义 prompt 的 playbook，引用 `.claude/` 约定）
