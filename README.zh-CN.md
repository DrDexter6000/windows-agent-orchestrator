# Windows Agent Orchestrator (WAO)

[![version](https://img.shields.io/badge/version-v0.2.0-2f2f2f?style=flat-square)](docs/changelog-2026-10-01-v0.2.0.md)
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
  原厂 harness 上；共支持 8 个 backend 适配器——逐轴事实见生成的
  [能力矩阵](docs/surface/certification.md)。
- **Transcript 即事实来源**——每个 run 都可以从 `runs/<runId>.jsonl` 完整重建；
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

## v0.2.0 新增（2026-10-01）

- 全部 8 个 worker 席位运行在原厂第一方 harness 上（新增 backend：zcode、kimi-web、
  deepseek-acp）。
- 六轴 backend 能力矩阵与两层认证作为生成面发布：
  [`docs/surface/certification.md`](docs/surface/certification.md)。
- 采纳 semver；发版门槛证据（251/251 测试全绿，2026-10-01 实测）见
  [`docs/changelog-2026-10-01-v0.2.0.md`](docs/changelog-2026-10-01-v0.2.0.md)。

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

**里程碑 M0–M12 全部完成。** 已交付要点：多 backend 派发 + worktree 隔离 + 断点续跑 +
token/成本计量；声明式 DAG 工作流与参数化模板；证据链 scorecard；daemon 监管、诊断与
runtime 认证；workspace 绑定的派发/恢复/停止 + `run_wait` 存活观察；安全的 changed-path
投影、exact 交付证明与有界/脱敏 diff 审查；`disallowed_path` 保留失败的 advisory
`candidateInventory` 恢复 + Lead 授权的**不重调模型** `run_delivery_repackage`（复用原
worktree、base 与验证声明原地重检重验，不再调用 worker 模型）；`run_continue` 修正谱系；
23 工具冻结 MCP 面；逐命令执行预算。

认证是关于 worker 已记录可靠性的 advisory 证据，不是派发许可门。两层验证、delta 认证
规程与上游原语复核 SOP 见 [`docs/certification-runbook.md`](docs/certification-runbook.md)；
每席实时状态：`npm run cli -- registry list`。里程碑史：[`docs/roadmap.md`](docs/roadmap.md)；
在册技术债：[`docs/tech-debt.md`](docs/tech-debt.md)。

## 快速开始

```powershell
# 一键安装（下述步骤的薄封装；默认装到 %USERPROFILE%\wao）：
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/DrDexter6000/windows-agent-orchestrator/main/install.ps1 | iex"
# 手动等价步骤：
git clone https://github.com/DrDexter6000/windows-agent-orchestrator.git D:\projects\windows-agent-orchestrator
cd D:\projects\windows-agent-orchestrator
npm ci            # 按入库的 package-lock 安装（npm install 可作回退）
npm link          # 可选，每机一次：暴露顶层 `wao` 命令（如 `wao dashboard`）

# 1. 配置 agent registry——从一个 worker 起步
#    推荐自动化路径：从入库模板生成单 worker 的 config/agents.json 并打印 MCP 片段：
#      npm run cli -- wao onboarding --agent <id> --apply
#    （在手工复制之前先跑它——已存在 config/agents.json 时它会拒绝覆盖。）
#    手工等价步骤：
Copy-Item config/agents.example.json config/agents.json
#    agents.example.json 是入库模板，与 canonical 团队角色一一对应——不要改它。
#    你复制出的 agents.json 是 gitignored 的、由你裁剪：只保留你真有 runtime/认证
#    路径的 worker，其余删掉。一个 runtime 就够用 WAO。
#    各 runtime 的认证方式选择表见 AGENT_ONBOARDING.md。
#    把保留 worker 的 cwd 改成它该操作的项目。

# 2. 校验 registry（此步不需要任何 runtime）
# registry list = inventory + certification status; registry validate = static schema; registry check = live opencode health
npm run cli -- registry list --registry config/agents.json
npm run cli -- registry validate --registry config/agents.json
#    registry check 探测活的 opencode-serve backend（维护档 lane）——仅当你保留了
#    opencode fallback worker 并启动了 scripts/serve.ps1 时才适用。

# 3. 接入 MCP Host（主控制面——决定 0017）
#    在 WAO 安装根目录（你 clone 的仓库）里跑。把任意 MCP host（Claude Desktop /
#    Codex / OpenCode）指向这个 stdio 入口；各 host 的绝对命令/args 示例在
#    docs/usage.md §MCP stdio：
npm run mcp -- --registry config/agents.json --run-dir runs
#    workspace 由 host 授权（roots/list / workspace_select）；
#    下方的 --cwd 只影响 CLI 侧的 workspace 观察。

# 4. 用 CLI fallback 跑第一次只读 canary（一个保留的 worker）
#    把 <agentId> 换成第 2 步 `registry list` 里的任意 worker id——
#    canary 对任何保留的 process worker 都可用：
npm run cli -- run <agentId> --prompt "Read package.json and summarize what WAO does" --cwd <目标项目> --registry config/agents.json --format json
#    <目标项目> 必须是本机已存在的目录——全新机器可以临时用 WAO 仓库本身
#    （只读 canary 对它无副作用）；见 AGENT_ONBOARDING.md §4f。
```

步骤 1–4 的完整展开（含各 runtime 认证）在
[`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md)。

仅支持 Node **v22**（`node --version`；`engines.node` 为 `>=22 <23`）。v24 目前是
Active LTS，但被 WAO 的版本守卫拒绝——v24 的 libuv Windows Job Object 回归会杀死
长寿命子进程。WAO 所有 npm script 都走 v22 shim（`scripts/wao-node.cjs`），所以默认
v24 的机器只要在约定路径装了 Node 22（或设置了 `WAO_NODE`）即可；见
AGENT_ONBOARDING.md §3。

## 文档地图（单一事实来源）

| 你想…… | 读这个 |
|---|---|
| **从零开始——安装、单 worker、校验、MCP host、首个 canary** | [`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md)——唯一的新用户上手路径 |
| **作为 agent / 脚本使用编排器**（23 个 MCP 工具、命令、工作流、配置） | [`SKILL.md`](SKILL.md)——面向 agent 的使用手册 + 工具表 |
| **作为人类部署 / 配置 / 运维** | [`docs/usage.md`](docs/usage.md)——完整部署与使用指南 |
| **查工具参数或 CLI 旗标** | [`docs/surface/`](docs/surface/)——生成参考（再生成：`npm run gen:surface`）；仓库索引：[`llms.txt`](llms.txt) |
| **对比 backend 能力 / 理解认证** | [`docs/surface/certification.md`](docs/surface/certification.md)（生成）+ [`docs/certification-runbook.md`](docs/certification-runbook.md) |
| **查每席实时派发认证** | `npm run cli -- registry list`（数据：`runs/reliability-summary.json`，gitignored，由 `npm run reliability` 生成） |
| **看每个版本发了什么** | `docs/changelog-*.md` 快照（最新：[v0.2.0](docs/changelog-2026-10-01-v0.2.0.md)） |
| **跑真实 smoke 测试**（claude/codex/opencode） | [`docs/smoke-guide.md`](docs/smoke-guide.md) |
| **理解架构**（分层、接口、状态机） | [`docs/02-architecture.md`](docs/02-architecture.md) |
| **看需求 / 非目标 / 验收** | [`docs/01-prd.md`](docs/01-prd.md) |
| **跟里程碑 / 进度** | [`docs/roadmap.md`](docs/roadmap.md) |
| **看在册技术债** | [`docs/tech-debt.md`](docs/tech-debt.md) |
| **读调研 / 设计决策** | [`docs/research/`](docs/research/) |

仓库贡献规范（原则、代码风格、约束）在 [`AGENTS.md`](AGENTS.md)。

## 命令速览

WAO 是 MCP-first（决定 0017）；CLI 是人/运维的 fallback，调用同一共享 application
services。

```powershell
# MCP server（主控制面——任意 MCP host 指向这里）
npm run mcp -- --registry config/agents.json --run-dir runs

# CLI fallback——常见 Lead 闭环
npm run cli -- run <agentId> --prompt "..."             # 派发 + 等待
npm run cli -- spawn <agentId> --prompt "..."           # 发后不管
npm run cli -- status|tail <runId>                      # 观察
npm run cli -- collect <runId> [--cursor T --format json]   # 有界 worker 输出 + 续读
npm run cli -- runs diagnose <runId>                    # 失败归类
npm run cli -- runs delivery <runId>                    # changed-path 投影
npm run cli -- runs delivery review <runId>             # 安全的有界/脱敏 diff 审查
npm run cli -- stop <runId>                             # 停掉失控 worker
npm run cli -- runs list                                # 恢复清单
npm run cli -- runs metrics <runId>                     # tokens / 成本
npm run cli -- runs scorecard <runId>                   # 证据门结果
npm run cli -- playbook list|show <id>                  # 可选的 Lead playbook 目录

# 声明式 DAG 工作流
npm run cli -- workflow run <file.mjs> [--vars k=v]
```

完整命令参考：`npm run cli -- help`；23 工具 MCP 表与路由契约见 [`SKILL.md`](SKILL.md)。

## 测试

```powershell
npm test            # 全部单元/集成测试（mock 子进程，不需要 API token）
npm run smoke       # 真实 CLI smoke（claude/codex/opencode——消耗 API token）
npm run reliability # runtime/model 认证矩阵——消耗 API token
```

## 许可证

基于 [Apache License 2.0](LICENSE) 授权。Copyright © 2026 DrDexter6000。
