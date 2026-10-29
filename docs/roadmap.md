# Roadmap

里程碑与当前状态。还没了结的事项在 `docs/tech-debt.md`，为什么这样定在 `.wao/decisions/`。各里程碑的完成定义、验收记录与收尾细节在冻结快照 [`archive/roadmap-2026-10-14.md`](./archive/roadmap-2026-10-14.md)。

版本号以 `package.json` 为准；semver 与 v1.0.0 门槛见决定 0038。

## 里程碑

| M | 内容 | 状态 |
|---|---|---|
| M0 | 地基：transcript 扩展、显式状态机、RunManager | ✅ 完成 |
| M1 | 统一事件流：opencode-serve 改为消费 RunHandle.events | ✅ 完成 |
| M2 | 第二个 runtime：ProcessBackend 与 parser | ✅ 完成 |
| M3 | 隔离与恢复：worktree、进程隔离、端口表、runs resume | ✅ 完成 |
| M4 | 可观测：token / 时长 / 命令数聚合 | ✅ 完成 |
| M5 | DAG 编排骨架 | ✅ 完成（已随决定 0094 退役） |
| M6 | scorecard 与可插拔节点 | ✅ 完成（可插拔节点已随决定 0094 退役） |
| M7 | 持久执行与监督恢复：daemon、验收契约 | ✅ 完成 |
| M8 | Lead 体验层：编排便利下沉为工具默认行为 | ✅ 完成 |
| M9 | Agent Runtime Control Surface：MCP server 与共享 application services | ✅ 完成 |
| M10 | 真实多 worker dogfood：workspace 绑定与外部项目协作 | ✅ 完成 |
| M11 | Lead Experience + Adaptive Playbooks | ✅ 完成 |
| M12 | Lead Token Efficiency + Assisted Orchestration：产品合同重置（决定 0018）与 Lead token 效率 | ✅ 完成 |
| M13 | 会审产品化：`wao consult` / `run_consult` | ✅ 完成 |

现在没有进行中的里程碑，工作按台账推进。

## 仍然有效的约束

- 权威边界：WAO 自动监测，不自动监督；自动封装，不自动验收；自动呈现，不自动决策（决定 0018）。
- MCP 工具面的上下文预算、扩面前提与红线：决定 0078。
- 不排期 POSIX lane：`docs/01-prd.md` §4。
