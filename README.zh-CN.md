# Windows Agent Orchestrator (WAO)

[![version](https://img.shields.io/badge/version-v0.8.1-2f2f2f?style=flat-square)](docs/changelog-2026-11-03-v0.8.1.md)
[![license](https://img.shields.io/badge/license-Apache--2.0-2f2f2f?style=flat-square)](LICENSE)

[English](README.md) · 简体中文

**旗舰智力，平价劳力，常设会审。**

> 本文件是 [`README.md`](README.md) 的中文镜像（内容同步维护，事实以英文版与各权威文档为准）。

让你已有的 coding agent 订阅真正干活。WAO 让一个 Lead agent——或任意 MCP host 里的你——把
Claude Code、Codex、Kimi、GLM（ZCode）、DeepSeek 作为 worker 派发到真实仓库上干活：
token 账单落在 worker 自己的 provider 配额上，每次运行都落成可审计的 transcript，
而控制面永远不替你做决策。

> **价值与边界（ADR 0018）：** WAO 的价值是把 worker token 消耗路由到外部 provider
> 配额——让 Lead 把真实工作派给外部 worker runtime，账单记在 worker 的 provider 上，
> 而不是把工作拉回 Lead 自己的上下文里烧钱。WAO 是辅助执行控制面，不是门禁，也不是
> 第二个语义总管。WAO 自动监测，不自动监督；自动封装，不自动验收；自动呈现，不自动决策。
> (English: WAO monitors, never supervises; packages, never accepts; presents, never decides.)

> **初次接触 WAO？** 从 [`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md) 开始——它是从零到
> 可用环境的唯一权威路径：安装 WAO、只配置**一个** worker、校验、接入 MCP Host、跑第一次
> 只读 canary。你**不需要**装齐所有 runtime 或备齐每家 provider 的凭证。

## 为什么选 WAO

- **账单路由**——worker 跑在各自的 provider 配额上，Lead 的上下文保持小而便宜。
- **原厂 harness**——WAO 直接驱动各厂商自己的 CLI，不做协议重实现：ZCode 驱动 GLM、
  Kimi 桌面 web 通道、Codex CLI、DeepSeek over ACP。参考机队的全部 8 个席位都运行在
  原厂 harness 上；共支持 7 个 backend 适配器——逐轴事实见生成的
  [能力矩阵](docs/surface/certification.md)。
- **Transcript 即事实来源**——每个 run 都可以从其转录完整重建（新档在 `runs/projects/<slug>/<runId>.jsonl`，旧档平铺 `runs/<runId>.jsonl`）；
  交付审查是有界且脱敏的投影，永远不是裸 diff。
- **监测，不监督**——WAO 观察、封装、呈现证据；语义裁定（接受/拒绝/返工）永远归 Lead。
- **Windows 原生，体积极小**——纯 Node ESM；仅两个直接生产依赖
  （`@modelcontextprotocol/sdk` + `zod`，且限定在 `src/mcp/**`）；无 Docker/WSL；
  worktree 隔离与进程树清理针对 Windows 调优。

## 智力的用人制度

- **让贵的脑子管判断，便宜的算力管干活**——把最强的模型放在顾问与审计席（方案评审、
  交付把关），批量执行交给高性价比 worker。不是每个席位都要配两百美元档的月订阅；
  旗舰级审查用在你认定要紧的关口。
- **三个臭皮匠，顶个诸葛亮——还比诸葛亮便宜。** 跨族系多席会审把多家顶尖模型的判断
  汇入同一条决策链；不同族系犯不同的错，交叉审查互相补盲。这一思路有独立佐证——
  OpenRouter 的 Fusion 议会[报告称](https://openrouter.ai/blog/announcements/fusion-beats-frontier)
  更便宜的模型组合在基准上超过前沿旗舰，Mixture-of-Agents 论文
  （[arXiv:2406.04692](https://arxiv.org/abs/2406.04692)）以纯开源模型在
  AlpacaEval 2.0 上超过 GPT-4 Omni。WAO 把同一原理做成审查纪律：意见留痕，裁定归
  Lead；效果因任务与配置而异。

## v0.8.1 新增（2026-11-03）

- **worker 的边界由 WAO 给，不再靠每份任务书手写**——每个只读运行（包括会审席）都在角色之前
  收到一份只读执行合同：不改项目文件（任务要求跑的测试产生的报告与缓存除外），不对工作目录或任何已有检出跑写仓库的 git 命令，实验只在
  系统临时目录下新建的目录里做，不读凭据、不打印环境变量，命令跑完再结束回合。交付合同补上写入
  只在工作树内，以及同样的凭据与收尾条款。复用会话的只读运行 resume 时回到自己的工作树，不再
  跑回源仓。
- **会审席写文件能被发现了**——"只读席位写文件即判 FAIL"此前从没触发过；现在按席位隔离树内
  用工具写过的文件计数，临时目录里的实验不算。
- **等一场会审只要一条命令**——`consult wait <id> --until-settled` 等到每个已派发的席位都收口才返回；
  `consult show <id> --out-dir DIR` 把每席完整原文各写一个文件。
- **正确性**——上了锁（`git worktree lock`）的工作树一律不删，`wao worktree remove` 确认登记的
  树没了才报 `removed`（TD-332）；`runs verify-commit` 的临时树同样处理；codex 的
  "model is at capacity" 诊断为 `provider_capacity` / `overloaded`（TD-329）。
- **版本号**——从本版起，0.x 阶段只有升级要动手时才升 MINOR，向后兼容的改动升 PATCH（决定 0109）。
- 范围、会审记录与发版门槛证据见
  [`docs/changelog-2026-11-03-v0.8.1.md`](docs/changelog-2026-11-03-v0.8.1.md)。

## 当前状态

WAO 是 **MCP-first 控制平面**（决定 0017）。任意 lead agent runtime——Claude Desktop、
Codex CLI、OpenCode 或任何 MCP host——以 stdio MCP server 方式驱动 WAO。WAO 拥有派发、
状态、隔离、transcript、交付验证与 Lead 接受/拒绝决策的持久记录（它记录 Lead 的决策，
不替 Lead 决策）；worker 只收到有界的任务 prompt，不参与编排。

WAO 暴露 **23 个 MCP 工具**，覆盖受监督的 Lead 闭环：

> `inventory → workspace_status → dispatch → await result → delivery query/review → Lead decision`

外加 `runs_list` 恢复入口。`run_consult`（CLI `wao consult`，即 **Agent Union**）召集
有界多席跨族系咨询：机械扇出、原文收集、council-diff 把每席完整原话并列呈现——
意见留痕、绝不自动合成，分歧由 Lead 读取裁定。Playbook 目录按需经 MCP resources（`wao://playbooks`）读取，
不占工具面。每个改状态的操作都与 CLI fallback 调用同一共享 application service，产生
相同的 transcript 持久事实。工具表与路由契约见 [`SKILL.md`](SKILL.md)。

**里程碑进度**：以 [`docs/roadmap.md`](docs/roadmap.md) 为唯一权威（每期范围与完成状态都在那里）——README 刻意不复述已完成范围。

认证默认是关于 worker 已记录可靠性的 advisory 证据，不是派发许可门；Owner 可在 MCP 边界打开门禁，只派已认证车道。两层验证、delta 认证
规程与上游原语复核 SOP 见 [`docs/certification-runbook.md`](docs/certification-runbook.md)；
每席实时状态：`npm run cli -- registry list`。里程碑：[`docs/roadmap.md`](docs/roadmap.md)；
在册技术债：[`docs/tech-debt.md`](docs/tech-debt.md)。

## 快速开始

照 [`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md) 做：

- §3 前置条件——环境检查，含受支持的 Node 版本
- §4a 装 WAO 本体——一条命令安装器或手动步骤；升级与回滚
- §4b 把 WAO skill 装进你的 agent runtime
- §4c 配置一个 worker——registry 模板与各 runtime 认证选择表
- §4d 校验 registry 与环境自检
- §4e 接入 MCP 宿主——`mcp bind` 与各宿主注册方式
- §4f 首次只读 canary

## 文档地图（单一事实来源）

| 你想…… | 读这个 |
|---|---|
| **从零开始——安装、单 worker、校验、MCP host、首个 canary** | [`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md)——唯一的新用户上手路径 |
| **作为 agent / 脚本使用编排器**（23 个 MCP 工具、命令、配置） | [`SKILL.md`](SKILL.md)——面向 agent 的使用手册 + 工具表 |
| **作为人类部署 / 配置 / 运维** | [`docs/usage.md`](docs/usage.md)——部署与使用各页的地图 |
| **查工具参数或 CLI 旗标** | [`docs/surface/`](docs/surface/)——生成参考（再生成：`npm run gen:surface`）；仓库索引：[`llms.txt`](llms.txt) |
| **对比 backend 能力 / 理解认证** | [`docs/surface/certification.md`](docs/surface/certification.md)（生成）+ [`docs/certification-runbook.md`](docs/certification-runbook.md) |
| **查每席实时派发认证** | `npm run cli -- registry list`（数据：`runs/reliability-summary.json`，gitignored，由 `npm run reliability` 生成） |
| **看每个版本发了什么** | `docs/changelog-*.md` 快照，清单见 [docs/archive/README.md](docs/archive/README.md) |
| **跑真实 smoke 测试**（claude/codex） | [`docs/smoke-guide.md`](docs/smoke-guide.md) |
| **判断何时跑全量、何时跑定向测试** | [`docs/testing.md`](docs/testing.md) |
| **理解架构**（分层、接口、状态机） | [`docs/02-architecture.md`](docs/02-architecture.md) |
| **看需求 / 非目标 / 验收** | [`docs/01-prd.md`](docs/01-prd.md) |
| **跟里程碑 / 进度** | [`docs/roadmap.md`](docs/roadmap.md) |
| **看在册技术债** | [`docs/tech-debt.md`](docs/tech-debt.md) |
| **读调研 / 设计决策** | [`docs/research/`](docs/research/) |

仓库贡献规范（原则、代码风格、约束）在 [`AGENTS.md`](AGENTS.md)。

## 许可证

基于 [Apache License 2.0](LICENSE) 授权。Copyright © 2026 DrDexter6000。
