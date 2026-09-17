# 0028: zcode-as-backend 放弃迁移，保持 claude-code
status: accepted
date: 2026-09-17

## Context

> **归档补正，不是重新审议**（TD-161 处置文档批）：Owner 2026-08-15 的裁定与重看触发器
> 此前登记在 docs/tech-debt.md TD-116 行内——Decision 类知识 mis-shelved（ssot.md §1.2
> 应为 ADR）。本文件把它升格为 ADR；事实来源为 TD-116 行（裁定与核实）、TD-161 行（2026-09-03 Owner 澄清）与 docs/02-architecture.md backend enum（五成员名单），不添加新事实、不把 2026-08
> 的核实结果写成当前能力结论。该行自本 ADR 起退为冻结证据记录。

- **构想**：zcode-as-backend——coder_hq 脱离 claude-code wrapper，改用 ZCode 桌面内置 CLI
  （zcode.cjs）headless `--prompt --json` 直驱 GLM-5.3。
- **2026-08-15**：coder_mm/auditor 双咨询评估（run_20260814235928766l1gent /
  run_20260814235936986bt100o，全文留档本地 `.dev/consult/` 未入库）；Owner 当日裁定
  （见 Decision）。
- **2026-08-19**：app-server 通道补充核实（Lead 会话内主动核查，无派发）——CLI 内置
  `app-server` 子命令（"ZCode Protocol" stdio 服务）存在性经只读 `session/list` probe
  确认；`session/send` 在 turn 运行中硬拒绝（-32010），无在途注入。Owner 裁定维持。
- **2026-09-03**：Owner 澄清——指令明示要求 ZCode CLI 驱动 runtime 本身；provider lane
  （backend 不变、只改 provider/model 字段）只解模型面，不构成对此需求的满足（引发
  TD-161 接入知识可发现性债）。

## Decision

**放弃迁移，保持 claude-code（Owner 2026-08-15）。**

- **硬门槛**：headless 在途纠偏通道（`run_correct` 类）缺失——headless 单次执行无 stdin
  追轮（桌面"引导模式"不覆盖 headless；官方无公开 ACP/SDK，第三方 zcode-acp 为早期项目）。
- **重看触发器（两腿须同时满足）**：
  1. ZCode CLI 提供 headless 多轮在途注入（stdin 或稳定 app-server 协议——app-server
     通道存在性已于 2026-08-19 核实，但 `session/send` 无 delivery/queue 参数、turn
     运行中硬拒绝，在途注入腿未满足）；
  2. 官方公开协议承诺或社区成熟方案。
- **重启前置**：Owner 一次性 `zcode login`（OAuth 无法代办）+ raw-capture 实测清单
  （`--json` 流式形态与工具事件结构等——完整清单见 docs/tech-debt.md TD-116 行，不复制）。

## Consequences

- backend 闭集维持五成员（opencode-serve / claude-code / codex / kimi-code /
  deepseek-harness；见 docs/02-architecture.md AgentDef.backend enum）。
- 重看不重开归 Owner 裁量：触发器满足不自动授权实施；本 ADR 只承诺裁定与重看触发器在
  operator 决策点可发现（TD-161）。
- 完整证据链（probe 脚本、实装版本、法医细节）留存于 docs/tech-debt.md TD-116 行，本
  ADR 不复制。
