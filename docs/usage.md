# 部署与使用指南

按要做的事分页，每页自成一体。命令与参数的完整参考在生成层 `docs/surface/cli.md` 与 `docs/surface/mcp-tools.md`。

| 页 | 什么时候读 |
|---|---|
| [安装与配置](usage/install.md) | 第一次安装 WAO、写配置、验证安装 |
| [车道配置与维护](usage/lanes.md) | 配置一条车道、kimi 与 deepseek 车道的前提、维护 kimi 车道的 serve、认证入口 |
| [接入宿主与绑定项目](usage/host.md) | 把 MCP 服务注册进表内七类宿主（宿主表见该页），绑定项目 |
| [派发](usage/dispatch.md) | 派出一个 worker：前台或后台、并行、工作树隔离、重试与恢复、续跑、纠正 |
| [监督](usage/supervise.md) | run 在跑时：等待、看状态和活动、停止 |
| [取结果与查历史](usage/results.md) | 取回答、诊断、脚本消费 JSON、列出与统计 run |
| [交付与验收](usage/delivery.md) | delivery 模式派发、审查、重验证、验收或拒收、重打包 |
| [会审](usage/consult.md) | 多席只读会审、会审席位记录、审计席测试协议 |
| [维护](usage/maintenance.md) | 清理历史 run 与工作树、daemon、Owner 看板 |
| [transcript 格式](usage/transcript.md) | transcript 的位置与事件清单入口（清单在生成层） |

排障见 `docs/troubleshooting.md`，认证操作见 `docs/certification-runbook.md`，开发 WAO 本身时怎么跑测试见 `docs/testing.md`。

## MCP 工具名 ↔ CLI 命令速查

MCP 工具面（ADR-0021 冻结）与 CLI 子命令名**不一一对应**——本表按用途映射，非改名（名字两侧均不动）；本表由 docs-consistency 守卫绑定断言（MCP 名派生自 `toolSurface.js` TOOLS、CLI 名派生自 `RUNS_SUBCOMMANDS` 导出，表内名字漂移即红）。完整参数见生成层 `docs/surface/`（权威源是代码，随代码再生成）。

| 用途 | MCP 工具 | CLI 等价 | 差异注 |
|---|---|---|---|
| 单 run 状态 | `run_status` | `runs diagnose <runId>`（诊断视图）/ `runs metrics <runId>`（指标视图） | 无单一等价——MCP run_status 是即时快照，CLI 按"要诊断还是要指标"分两命令 |
| 等待/观察 | `run_wait` | `runs wait <runId>` | 同一 service，等价 |
| 收集结果 | `run_collect` | `collect <runId>` | 等价（CLI 另有 `--final`/游标续读） |
| 全局统计 | —（无直接等价） | `runs summary` / `runs list` | MCP 侧用 `runs_list` 按需过滤 |
| run 列表 | `runs_list` | `runs list` | 等价 |
| 派发 | `run_dispatch` | `run <agentId> …` | MCP 无前台阻塞语义，CLI run 前台等待 |
| 验收/交付查询与决策 | `run_delivery` / `run_delivery_decide` | `runs delivery <runId> [--accept/--reject]` | CLI 覆盖查询与 accept/reject；review 见下行 |
| 交付审查（diff/review） | `run_delivery_review` / `run_delivery_review_bundle` | —（无 CLI 等价，MCP 独有） | CLI 侧用 `runs delivery` 查询 + 本地只读 Git 兜底 |
| 停止 | `run_stop` | `stop <runId> --observed-seq <n> --reason "<理由>"` | 等价（都要先看最新状态、写明理由，决定 0069） |
| 台账诊断 | `run_diagnose` | `runs diagnose` | 等价（MCP 返回含 state/terminal；CLI JSON 分支刻意不含） |
