# 0095 Lead 及时得知运行收口：通用的收口等待与下一步提示，不做宿主专属推送

- 日期：2026-10-29
- 状态：accepted
- 来源：
  - Owner 2026-10-29 观察："wao的lead agent……都会把任务发出去之后不轮询、坐等worker agent交作业……最后必须人类用户等不下去了、手动提醒"。他要的是 Lead 可以自定轮询间隔甚至不轮询，worker 交付后由 WAO 的原子能力让 Lead 知道。
  - Owner 2026-10-29 三点答复：同意 CLI "等到收口"，并问 MCP 是否也要（"免得使用mcp的lead agent犯傻"）；"我不喜欢wao对claude code做针对性开发，我更喜欢普适性、泛化性强的方案"；没有唤醒入口的宿主，在等待返回时提示 Lead 再挂等待。随后对第 49 批范围答"同意"，含本批 MCP 工具面重冻（决定 0078）。
- 关系：了结 TD-322。修订 `run_wait` 的 180 秒下限（它只写在使用手册与架构文档里，没有成文决定）。不改决定 0030（到期只通知、不停 worker）与 0067–0069（生命体征只告知、去留由 Lead 定）。
- 方案会审：kimi 与 deepseek-flash（consult_20261029210758248f9320e），sol 两轮（consult_20261029211748020j30v0y、consult_20261029212626409u6zuqn）。
- 合入授权：Owner 2026-10-12——"只要是你联合会审过的，我都许可 commit & push"。

## 背景

- `runs wait` 与 `run_wait` 单次最多 600 秒：一小时的 worker 要挂六次，哪一次回合结束时忘了续挂，就再没有东西会叫醒 Lead。
- MCP 的 `run_wait` 下限 180 秒、`run_wait`/`run_await_result`/`run_consult`/`run_delivery_review_bundle` 默认 270 秒。在约 60 秒就让 MCP 调用超时的宿主上（已观测：桌面端 Code 标签），这些调用必然超时（TD-322）。
- 到期提示只陈述"观察窗到期非终态"，不说下一步。
- WAO 没法从外部替宿主开启 Lead 的新回合；能做的是让"收口"这件事可以被一个命令、一次调用干净地等到，并在每次没等到时把下一步说清。

## 决定

1. **收口是一个闭集判定**（应用层纯函数，CLI 等待器与 MCP `run_delivery` 的等待共用）。在同一份可信快照上：
   - 运行已终态；
   - 交付阶段按现有投影的分支顺序：未请求交付、打包失败、隔离失败算收口；
   - 交付已创建时：原始验证有了结果（已有决定也要等验证结果），最新 reverify 链有了结果；
   - 事实校验 malformed、原始验证尚无结果却已有 reverify 事实、reverify malformed、孤立的 reverify 链、终态后既无创建也无失败（ambiguous），都是"无法判定"，不是收口。
   - 收口只保证运行与其交付验证、reverify 都已有结果；不表示验证通过或 Lead 已验收，WAO 的收尾（会话中止核验、树释放）可能仍在进行。
2. **CLI `wao runs wait <runId> --until-settled`**：每 15 秒解析一次路径、读一份快照、判定一次，只用本轮快照。
   - 无法判定或不可信的轮（读取失败、解析降级、多副本之一读不出、交付事实不可判定）连续 4 次即非零退出，并给出诊断入口；
   - 持久冲突（多副本内容不同）立即非零退出；
   - 判定收口后再确认一次解析结果。
   - 不设总时长，只读，不停 worker。
3. **下一步提示 `nextStep`**（新字段，不复用 `run_status` 的 `leadAdvisory`，那是"静默 30 分钟"的含义；也不进只陈述事实的 `semanticNotes`）：英文固定模板，按面渲染（MCP 写工具名、不含 runId；CLI 写命令）。
   - 生命体征年龄取快照里最后一条 worker `run.event` 的绝对时间，含 `runtime_activity`。
   - 出现在：CLI `runs wait` 与 `--until-settled` 的输出；MCP `run_wait`；MCP `run_delivery` 带 waitMs 且未收口时；`run_dispatch`、`run_continue` 受理后台运行时；CLI 后台派发与 resume、daemon 的提示。
4. **MCP 短等待**：`run_wait` 下限改为 30000。MCP 的 `run_wait`、`run_await_result`、`run_consult`、`run_delivery_review_bundle` 默认改为 45000（已观测最紧的宿主约 60 秒，留 15 秒余量），上限不变，宿主允许长调用时 Lead 可显式加长。CLI 的默认值保持不变，与 MCP 的默认值各自命名。
5. **Lead 纪律**（SKILL）：手上有在跑的运行，结束回合前必须已挂好等待。

## 否决的备选

- **宿主专属推送**（如 Claude Code channels）：只覆盖一个宿主，Owner 明确不要。
- **MCP 长阻塞到收口**：调用时长由宿主的超时决定，阻塞一小时在多数宿主上都会中途超时，Lead 连 worker 状态都看不到。
- **WAO 常驻的提醒进程**：WAO 没有进入宿主会话的通道，提醒只能送到人，解决不了 Lead 不知道的问题。
- **复用 `leadAdvisory`**：同名字段会有两种含义。

## 已知边界

- 等待命令只保证在收口时退出；能不能因此唤醒 Lead 取决于宿主：有的宿主在后台命令结束时通知 Lead，有的不会，那就只能靠 `nextStep` 与 Lead 纪律缓解。
- runner 已死或验证结果丢失的运行会让等待器一直挂着：非终态满 30 分钟未见新体征时给出 `runs settle` / `stop` 两个出口；终态等验证时它分不清验证慢还是结果已丢，只指向 `runs delivery`。出口都不自动调用。
  - 2026-10-30 起见决定 0096：后台运行的验证者能证明已不在时，等待器退出 3（`verifier_gone`）。
- 解析与读取不是同一个原子操作：每轮重解析、收口前再确认，仍不能排除最后那一轮里刚刚出现的分叉。
- 45 秒是观察预算，不是整个调用的硬时限：consult 串行派发、bundle 读取评审都可能使调用更长。
- Lead 在等待结束后发起的 reverify、repackage、review、decide 是另一段工作；并发 repackage 在转录上不可见，不在收口判定之内。
