# 技术架构 Spec

> 状态：契约层。本文档定义 WAO 当前的**接口契约、数据模型、状态机、模块边界**，不含具体算法实现，随代码同步维护。
> **实现进度**见 `docs/roadmap.md`，**技术债**见 `docs/tech-debt.md`。
> 上游：`docs/01-prd.md`（需求）；决策记录见 `.wao/decisions/`。
>
> **权威边界**：WAO 自动监测，不自动监督；自动封装，不自动验收；自动呈现，不自动决策。（English: WAO monitors, never supervises; packages, never accepts; presents, never decides.）为什么见决定 0018。
> Lead 独占需求/目标/拆解/并行串行/worker 与 context 与 allowed paths/verification/acceptance criteria/
> correction prompt/retry/switch/scope/fallback/语义审查/accept-reject/集成/报告。
> WAO 只机械执行 validate/resolve/inject/execute/observe/preserve/redact/project/collect exact evidence/
> run Lead-specified checks/package bounded artifact/record Lead decision。`run_wait` 是 liveness observation，supervision 属于 Lead。certification/readiness 是 advisory evidence，不是 permission gate。

---

## 0. 阅读约定

- TypeScript 风格的伪类型用于描述接口，但实现语言是 **JavaScript ESM**（无 TS）。

---

## 1. 分层总览

```
┌──────────────────────────────────────────────────────────────┐
│ L4 接口层    MCP Server (agent-facing primary)                │
│              CLI client (human/ops/debug/fallback)            │
│              事件/资源订阅                                     │
│              shared application services                       │
├──────────────────────────────────────────────────────────────┤
│ L3 编排层    已退役（决定 0094）——多步编排归 Lead            │
├──────────────────────────────────────────────────────────────┤
│ L2 控制平面  RunManager · 状态机 · 调度器 · 隔离 · 恢复        │
├──────────────────────────────────────────────────────────────┤
│ L1 运行时抽象 Backend 接口 · Registry · Transcript            │
└──────────────────────────────────────────────────────────────┘
     横切：scorecard（门控审计）· metrics（可观测）
```

**L4 依赖方向**（`test/isolation-infra/layering.test.js` 全 src 方向矩阵机器强制）：

```
adapters ──→ application ──→ core ──→ backends ──→ shared（最底层）
```

- **adapters**（所有外部面/入口）：`src/mcp/**`、`src/commands/**`、`src/cli.js`、`src/ownerDashboardServer.js`（第三个网络面：loopback HTTP 观察边界）、`src/daemon.js`、`src/daemonSupervisor.js`、`src/backgroundRunner.js`。
- **application**（Lead use-case 服务层）：`src/application/**` 中不在 shared/core 成员例外清单内者。
- **core**（生命周期与真值）：`src/transcript.js`、`src/runManager.js`、`src/delivery.js`、`src/registry.js` 及 `src/` 顶层其余非 adapter 非 shared 文件（含转录分桶路径权威 `src/projectBuckets.js`——新 run 写 `runs/projects/<slug>/<runId>.jsonl`，旧平铺只读兼容，定位一律经其三级解析链；与 transcript.js 同层=路径权威对）（diagnosis/isolation/scorecard/alerts/metrics/frictionLog 等）。
- **backends**：`src/backends/**`（runtime 适配与 parsers）。
- **shared**（共享内核/叶子工具，被所有层消费、零上向依赖）：`src/application/roleContract.js`、`src/application/credentialReadiness.js`、`src/application/ownerLiveness.js`、`src/application/timeoutPolicy.js`、`src/application/processStopVerify.js`、`src/cliHelp.js`（CLI help 单一常量源，供 adapter 与生成器消费）、`src/envPolicy.js`、`src/runEvent.js`、`src/secretRedaction.js`、`src/canonicalAgentId.js`、`src/projectIdentity.js`（项目身份规范化纯函数：cwd 规范化/稳定键/桶 slug 派生）、`src/waoCliPath.js`、`src/version.js`（CLI/MCP 版本常量，读 package.json 单一来源）、`src/keepAwake.js`、`src/runnerPrompt.js` + `src/hostAdapters/**`（出站宿主集成叶子，如 codexMcpConfig 委托 Codex CLI 管理 MCP 配置；其"adapter"指出站集成，非 adapters 桶的入站外部面）。
- `src/owner-dashboard/**` 是浏览器静态资产，不参与 Node import 图。

**方向规则（闭集，机器强制）**：**禁上向；任意下向（含跳层）与同层合法**。adapter 越过 application 直取 core/backends/shared 是声明合法的现状（呈现/入口层直连，application 不是收口点）。上向例外白名单为空（**恰 0 条**）：`application/sessionReuse.js` 经 CORE_MEMBERS 精确例外归 core 桶——它消费 `transcript.js`（core），是服务而非叶子，不能下沉 shared；registry/runManager 同层消费，runContinue/runDispatch/backgroundRunner 下向消费。守卫机制：冻结精确集合、双向 deepEqual、上限 12、变更须同步本图。未登记的新顶层文件或新子目录一律 fail-closed（不自动归 core）。

- MCP Adapter 和 CLI Adapter 只做 transport/input/output adaptation。
- Application Services 层是最小 Lead 闭环的 use-case 层。**共享 services**：
  - `registryInventory.js` — registry inventory SSOT，CLI 与 MCP 共用。
  - `runDispatch.js` — background 派发 service，CLI 与 MCP 共用。
  - `runStatus.js` — 只读 run status service。
  - `runCollect.js` — run collection service（非只读）。
  - `runDiagnosis.js` — 只读 run 诊断 service。
  - `runDelivery.js` — 只读 delivery 查询 + 持久决策：委托 `tryAppendDecision` 原子 first-decision-wins；`getRunDeliveryReadiness` 提供可选 bounded 只读 readiness wait + `projectDeliveryReadiness` 闭集投影，复用 `validateDeliveryFacts` SSOT（runId 绑定共享事实权威——见 §4.9），CLI/MCP 共用同一 service；`isolation_failed` 闭集状态 + `isolationFailure:{code}` 安全投影 + `projectIsolationViolationCode`——终端 delivery-requested run 且**唯一**较高优先级 delivery 事实为恰好一条 run-bound `run.isolation_violation(code=workdir_escape)` 时 settle 为 `isolation_failed`，与 packaging failure（`deliveryFailure`）严格分离，绝不带 candidateInventory/repackage/salvage/retry/stop/decision 面；facts 优先于隔离事实，缺失/多条/跨 run/malformed code 一律 fail-closed `ambiguous`。
  - `workspaceBinding.js` — host-authorized workspace proof SSOT。
  - `runStop.js` — workspace-bound 失控 worker 停止，CLI `stop` 与 MCP 共用。
  - `runList.js` — workspace-bound run 列表，CLI `runs list` 与 MCP 共用。
  - `runWorkspaceOwnership.js` — run 是否属于当前 workspace 的判定 SSOT。
  - `runWait.js` — long-poll 终态/活性等待，只读，MCP 共用。
  - `runAwaitResult.js` — 只读 advisory composite：bounded wait + truthful observation + terminal compact，snapshot-only 无 serve fetch，复用 `runWait` 的 `summarizeLiveness` + `runCollect` 的 `reconstructItemsFromEvents` + `runCollectProjection` 的 compact SSOT，零 audit append；必填可空闭集 `readFailureReason`——`READ_FAILURE_REASONS` 单一 SSOT，MCP schema enum 由它构建，read_failure 时给出 transcript_parse_failed/legacy_event_shape/snapshot_unavailable 机器码，observed 为 null，绝不泄漏错误原文。
  - `ownerLiveness.js` — run liveness 投影 SSOT：terminal/progress/process_only/silent，`runWait`/`runAwaitResult` 共用。
  - `runDeliveryReview.js` — exact delivery commit proof + bounded/redacted diff projection，CLI/MCP 共用。
  - `runCollectProjection.js` — run_collect 的共享安全投影 + cursor codec + 分页，CLI 续读与 MCP 委托同一投影，无第二算法。
  - `sessionWorkspace.js` — Lead 会话级工作区选择纯验证内核，委托 `workspaceBinding.js` 的 `proveWorkspace` SSOT；无状态——per-MCP-server 会话状态由 server 闭包持有，application 层不存全局/持久状态。
  - `runDrilldowns.js` — 有界 Lead 渐进式披露元数据 SSOT：静态闭集 catalog（tool/view/detail/purpose/reveals/cost/readOnly 七键）+ 纯事实选择规则 + 硬上限 `DRILLDOWN_MAX_ENTRIES`/`DRILLDOWN_SERIALIZED_MAX_BYTES`/`DRILLDOWN_FIELD_MAX_LEN`；`run_await_result`/`run_status`/`run_diagnose`/`run_collect`/`run_delivery`/`run_activity` 六个观察工具的输出携带（schema REQUIRED）`availableDrilldowns`，MCP schema 枚举与上限由同一模块导出派生，无第二份列表；只披露不调用、不决策、不广告 mutation/control 工具，`readOnly` 按工具如实（run_collect 三条为 false，余为 true），字段永不含 transcript/provider/仓库文本。

  CLI `runs delivery` / `runs diagnose` / `collect` / `status` 均委托共享 service。非 use-case orchestration 仍在 `src/commands/*.js` 中。
- 业务规则只写一次，在 application services 层。**禁止 MCP Server 通过 shell 调 CLI 并解析文本输出。** MCP adapter 直接 import 并调用 application service。
- RunManager / transcript / delivery / Backend 不依赖 MCP——MCP 是 L4 adapter，不是 L1-L2 dependency。`src/mcp/**` 是唯一允许 import `@modelcontextprotocol/sdk` 与 `zod` 的位置（由边界测试守卫）。`src/application/**` 不得 import `src/commands/*`、`src/mcp/*`、MCP SDK 或 zod。分层方向矩阵（禁上向，上向例外白名单为空）由 `test/isolation-infra/layering.test.js` 机器强制。
- MCP 工具面（当前 inventory；完整 23-tool 冻结清单见下方冻结工具面条目与 §7）：

  | 工具 | 性质 | 委托与契约要点 |
  | --- | --- | --- |
  | `registry_list` | 只读 | registry inventory 投影，委托共享 service（见上方 `registryInventory.js` 条目）。 |
  | `run_dispatch` | destructive，delivery-capable | 目标只取本次调用必传的 `expectedWorkspaceRoot`——证明为 canonical Git root 后作 server-owned `cwd`（缺参或证明不过即拒）。支持 delivery-only 顶层 `continuable`（见 `run_continue` 行）。 |
  | `run_status` / `run_collect` / `run_diagnose` | 只读 / 非只读非幂等 / 只读安全诊断（依次对应左侧三工具） | 均委托共享 application service（见上方 services 目录）。 |
  | `run_delivery` | 只读 delivery 查询 | 支持可选 `waitMs`（共享常量锁定 `[1000,300000]` ms），触发 bounded 只读 readiness wait 并返回严格闭集 `readiness`（`waiting_for_packaging\|waiting_for_verification\|reviewable\|packaging_failed\|isolation_failed\|not_requested\|ambiguous`，`isolation_failed` 见 `runDelivery.js` 条目；已校验的 pending 拒绝把 readiness 落为 `reviewable` 而 verification 仍显示 pending——规范见 §4.9）；CLI `runs delivery --wait-ms N` 与 MCP 委托同一份 `getRunDeliveryReadiness` service，`run_delivery_review` 的 exact-proof/安全投影/错误边界不因等待放松，省略 `waitMs` 时 point-in-time 输出向后兼容。 |
  | `run_delivery_decide` | destructive | 持久 Lead 决策，first-decision-wins。 |
  | `workspace_status` | 只读 | host-authorized workspace binding 状态查询。 |
  | `workspace_select` | 实例级 | Lead 选择工作 Git 项目（`lead_session` 来源）——只作只读工具的缺省范围（解析优先级 `lead_session` > `mcp_root` > `server_config`）；同实例的其他会话共享该选择；无需 bind/重启；会动工作区的调用不读它。 |
  | `run_stop` | destructive，workspace-bound | 停止失控 worker，委托共享 application service `runStop.js`（CLI `stop` 与 MCP 共用同一 service）。 |
  | `runs_list` | 只读 | project-bound run 列表，用于 recovery，委托共享 application service `runList.js`（workspace ownership 由 `runWorkspaceOwnership.js` 判定）。 |
  | `run_wait` | 只读 long-poll | 终态/活性等待，委托共享 application service `runWait.js`（liveness 投影 SSOT 在 `ownerLiveness.js`）。 |
  | `run_delivery_review_bundle` | 机械组合 | MCP adapter 机械组合同一 readiness service、同一 `run_delivery` 安全投影和同一单文件 review service/投影；默认等待 270 秒、settled early return，只在 `reviewable` 时读取 Lead 指定的一页，并绑定 delivery/review commit 与 changed-file count。它不选择或遍历文件/cursor、不做语义判断、不作 accept/reject；原子工具保持可用。 |
  | `run_delivery_reverify` | 审计式重验证 | 委托共享 application service `runDeliveryReverify.js`（CLI `runs delivery reverify` 与 MCP 共用同一 service），对同一未变 delivery commit 做审计式重验证——原始 assertion 命令逐字节重跑不可修改，Lead 只能追加 setup 命令，可重入/崩溃安全，每条重验链至多一条 outcome；一个交付至多两条链，第二条须 Lead 显式 `attempt: 2` 且第一条以可重验码失败；永不自动 accept/reject；原始 verification 与 `run_delivery` 投影的 `originalVerificationStatus`/`effectiveVerificationStatus`/`reverify` 链事实一并保留。 |
  | `run_continue` | delivery-only，Lead 显式授权 | 与 `run_dispatch` 共享 delivery-only 顶层 `continuable` 选项：Lead 审阅一个终态 continuable delivery、发现窄缺陷后，显式授权对其续 ONE 修正回合——WAO 创建新 run/transcript、复用父 run 的 retained worktree、以 `turn:resume` 续同一 provider-native 会话（opaque uuid 由 Lead session + canonical workspace + canonical agentId + rootRunId 派生，跨一条续谱复用，非 project-wide coder 复用），并打包新 child delivery。`continuable:true` 在 dispatch 时以 `run_lineage`/`turn:first` 建立续谱根。closed-set 只读资格检查覆盖输入与 delivery、父 run 身份/终态/acceptance、lineage/provider session、workspace/delivery、worker backend+model 配置、backend 能力、retained worktree 与并发占用，均先于 mutation；静态 argv/credential 亦先检查。retained-worktree 转换幂等且事务化，spawn 前失败恢复父 worktree、清理 child transcript 并释放 claim；第二次证明发现外部漂移时不覆盖外部状态（父 commit 对象永不删除，仍可按 SHA 审阅）。WAO 从不推断 correction/scope/verification/retry/acceptance——child delivery 的 review/accept/reject 仍归 Lead。 |

  opaque uuid、Lead id、workspace 路径、active lineage runId 永不出现在 MCP 输出。
- **只读 run 声明（advisory + 运行中告警，无硬门）**：`run_dispatch` 顶层 `readOnly:true` / CLI `run --read-only` 是 Lead 的**声明**而非门——链路为"声明 → 强制隔离 → 观察"。`runDispatch.js` 与 `RunManager.start` 双层拒绝 `readOnly × delivery`（闭集理由码 `read_only_delivery_conflict`；`readOnly × continuable` 被既有 delivery-only 门自然拒绝；`readOnly × correctable` 共存）；声明强制 ephemeral worktree 隔离（覆盖 isolate flag；readOnly×复用轮仍 persistent，见 usage.md），worktree 创建失败 fail-closed（typed `read_only_worktree_required`，**堵住**降级原 cwd 路径），并在 start 恰一次写 `run.read_only_declared` durable 事实（空 payload；`transcript.js` 幂等 append API 是唯一写入点，前台与 runner 汇聚于 `RunManager.start`）。`runReadOnlyObservation.js` 在同一冻结快照上投影 advisory `readOnlyObservation`（闭集 `no_writes_observed | writes_observed | unknown`，`source:"transcript_file_events"`，`observedFileCount`+脱敏 `writtenPaths` 帽 25 条）——权威 = 恰一条绑定 `run.started`（绝对 worktreePath）+ 恰一条绑定声明事件；任一 `file_written` 路径不可求值或权威/声明歧义 → 整体 `unknown`（fail-closed）。**诚实口径**：status 报当前快照观察（非终态也可 `writes_observed`——运行中告警，呈现≠动作）；`no_writes_observed` 是"未观察到写"（工具上报证据），非"没写"；`complete:true` 仅当快照终态且全部可求值。**Owner 约束**：越界写不停止、不失败、不改写自然终态——纯 advisory，终审归 Lead。观察只在快照含绑定声明事件时挂载（未声明 run 的 `run_activity` 输出字节不变）。
- 可观测性分成两个消费者面，共用同一事实投影：`runActivity.js` 单快照读取并做 workspace/runId 绑定，`runActivityProjection.js` 负责七类活动事件、secret redaction、控制字符清洗、有界 excerpt 与冻结 cursor；MCP `run_activity` 使用 `audience:"lead"` 的紧凑页面，Owner 组合 service `ownerDashboard.js` 使用更大的 `audience:"owner"` 页面。`runDrilldowns.js` 只向 Lead 返回静态 `availableDrilldowns` 提示，不自动下钻。`ownerDashboardServer.js` 是独立的人类观察边界：只绑定 `127.0.0.1`、每进程随机 bearer、严格 GET/query/CSP/no-store，且只复用上述 application services；`runs dashboard --web` 启动固定静态 UI。Owner 页面不会 stop/retry/continue/repackage/decide，也不改变 Lead 的语义裁决权。两种消费者都不直接解析 JSONL，详细合同与命令见 `docs/usage.md`。`runScopeObservation.js` 在同一快照上投影 advisory `scopeObservation`（闭集 `within_declared_paths | outside_declared_paths | unknown`，`source:"transcript_file_events"`，`observedFileCount` + 上限 25 条的脱敏 `outsidePaths`）——`complete:true` 的准确语义：快照已**终态**，且其中每条确认的 `file_written` 都能在**恰好一个有效合同权威**（绑定 runId 的 `run.started` 绝对 worktreePath + 非空合法 `delivery.allowedPaths`）下求值；它**不**证明文件系统完整性、语义正确性、交付验证或 Lead 验收，也**不**表示 worker 仍在运行（`complete` 的前提是快照终态）。未终态或任一确认路径不可求值 → `unknown`/`complete:false`。Windows 上绝对路径 containment 证明按平台大小写折叠；输出路径先 exact-secret 脱敏再 bound。
- **运行中显式纠正**：`runCorrection.js` 是 workspace-bound application service；`run_dispatch(correctable:true)` 只在 backend 明确声明 in-flight correction 能力时建立 durable correction queue，`run_correct` 以 bounded `correctionId` + prompt 把 Lead 明确指令追加到原 run，再由 runner 串行 claim 并送入同一 provider 进程。requested/claimed/delivered/delivery_failed/rejected 是 transcript 事实；`queued` 不等于 delivered，`delivered` 也不等于模型已理解或执行。该能力不创建 child run、不换 worktree、不扩大 delivery contract、不自动 stop/retry/accept；语义判断仍归 Lead。普通未 opt-in dispatch 字节兼容。
- **submitted-stage 与 Owner 详情/通知**：`runStageProjection.js` 从单 run transcript 快照投影 `accepted | spawned | active | terminal | unknown` 的事实阶段，只由 durable submitted/started/activity/terminal facts 建立，不预测进度、不判断产品语义。Owner Dashboard 复用同一 application projection 展示选中 run 的 backend/stage/terminal/event count/scope/liveness/timeline；浏览器 Notification 仅在人类点击启用、权限允许、且观察到非终态→终态时发送一次固定安全通知。所有异步详情响应用 `runId + selection epoch` 绑定，旧 selection 不得污染当前视图；页面仍为 loopback、bearer、GET-only 的纯观察面。
- **Owner Dashboard active-first / history-on-demand**：Owner 观察面默认 Active——只列出当前有新鲜 owner 心跳、经证明 active 的 run。Active 的候选集是当前 `.owner-*` 租约文件——候选枚举只 `readdirSync` 一次 runDir 目录（成本随目录条目总数增长、包括历史 transcript，但仅一次目录读），随后只有当前租约候选者的 transcript 被打开/解析、做 per-run workspace 验证与 `ownerLiveness` 心跳检查（昂贵工作是 O(当前租约数)，无任何历史 transcript 被打开/解析/验证）；`listRuns` 仍是单一应用 SSOT，以 `scanScope`（`active` 枚举租约候选并只保留 proven-active、`history` 按 transcript 派生 `updatedAt` 做有界闭集范围过滤、缺省行为字节不变）+ `historyRange` 扩展，**不是**第二个分类器，并复用既有 `ownerLiveness` 心跳真相与 closed-set activity 分类。Active 响应固定标注 `scanScope=active` 且不携带 `unresolvedCount`（active/history scope 不做全库存 unresolved 分类，故恒缺失而非 0）。历史是显式有界按需：`1h/24h/7d` 预设或有界自定义 from/to（上限 7d），由 `ownerDashboardServer.js` HTTP 闭集严格校验；长驻看板服务进程复用元数据校验 summary 缓存做热读，**无第二个持久索引**。前端 runs 列表绑定 runs-mode epoch（类比 selection epoch），迟到的 Active/History 响应不得覆盖当前模式或更新的查询；run 从 active 集或有界历史窗口消失绝不构成终态迁移、不触发通知。MCP `lead_preflight`/`runs_list` 热路径、CLI 文本看板、transcript writer、delivery 语义与验收权威均不受影响。详细命令与合同见 `docs/usage.md`。
- **冻结工具面**：WAO 暴露**恰好 23 个 always-registered MCP 工具**——"always-registered"指**任何完成 MCP 接入的宿主**连接后全部工具可独立调用；接入通路闭集与各宿主能力（snippet/autoBind/hostVerified 三轴，逐宿主取值以表为准；注册状态只读探测、表外宿主通用片段）由 `src/hostAdapters/hostDescriptors.js` 冻结描述符表唯一承载（决定 0043），host-neutral stdio 片段（`wao onboarding`）是任何 MCP 宿主的兜底接入路径——无 profile、无 startup flag、无 restart-to-recover。这是**呈现层**——它**不是**权限层、**不是**路由层、**不是** Host/runtime-name 适配器：代码里**没有任何**按 Claude/Codex/Kimi/OpenCode 的分支，也不依赖 `tools/list_changed` 或运行期动态注册。工具面的字节稳定性**分层**（ADR 0021）：`name` 与注册顺序逐字节冻结；`inputSchema`/`outputSchema`/`annotations` 由 description 剥离 SHA-256 冻结契约哈希锁定（仅限 additive 变更 + 显式重冻结记录）；`description` 可修订——受冻结字节天花板约束、每次修订附 Lead 复核记录。演进 additive-first，减面两级程序见决定 0021。单一冻结来源在 `src/mcp/toolSurface.js`（23 个名字的 frozen 数组 + 唯一性/计数/无 playbook 工具的模块加载不变量；server.js 在构造期对实际注册序列做 deepEqual 自检，绑定 production 到该 SSOT，无 Host/runtime 分支）。built-in playbook catalog **整体不在工具面内**，由 MCP resources（`wao://playbooks` summary + `wao://playbooks/{id}` 详情，委托同一 `application/playbookCatalog.js` SSOT）承载。stdio argv parser 将残留的旧 profile 参数视为普通未知 flag 忽略——不解析值、不出现在输出、不改变 server 面、不失败启动；`--registry`/`--run-dir`/`--workspace-root` 解析逐字节不变。所有 `DRILLDOWN_TOOLS` 闭集成员（`run_status`/`run_activity`/`run_collect`/`run_delivery`/`run_delivery_review`/`run_diagnose`）均在 23 集合内，故 `availableDrilldowns` 渐进式披露提示永不广告一个不可调用的工具；它只披露、不自动调用、不决策、不广告 mutation/control 工具。没有任何能力被永久移除或弱化——一个永不重启的 Host 保留全部操作能力（真删除式减面须 Owner 明示并修订本句）。
- **Self-Describing Results**：恰好四个 standalone 成功结果——`run_wait`/`run_await_result`/`run_delivery`/`run_diagnose`——携带 REQUIRED `semanticNotes`（1..4 条），每条恰好三键 `{id, meaning, doesNotMean}`：`id` 是冻结的 namespaced 闭集值，`meaning` 是一句确定性事实，`doesNotMean` 是 0..2 条确定性非含义。无 `scope` 字段、无 per-entry `semanticsRef`，详情 URI 机械派生 `wao://semantics/{id}`。单一纯、provider-neutral 的 SSOT 在 `src/application/runSemanticsNotes.js`（冻结静态目录 + 纯 selector，不导入任何东西、无 runtime/backend-name 分支、无动态模型文本、永不回显 transcript/provider/path/prompt/command/session）。目录与 selector 的事实输入来自既有闭集（`OBSERVATION_OUTCOMES`/`TERMINATION_SOURCES`/`DIAGNOSIS_CATEGORIES`/delivery readiness·verification）；未知/缺失值退化到显式安全 fallback note（见下），不新增事实闭集。强制点在 application 层：1..4 条、每串有界、id 唯一、精确三键、目录成员、≤2048 字节 UTF-8 序列化上限（空数组 fail closed）；未知 source tool fail closed，未知/future/缺失事实值退化到显式安全闭集 fallback note（`observation.unknown`/`termination.unknown`/`diagnosis.unknown`），永不动态回显（未知/缺失 observation outcome 不再误归 `observation.point_in_time`）。selector 优先级确定：`observation.read_failure` 排除任何终止 note；终止 note 区分 completion/execution_deadline/manual/provider/backend/control_plane/unknown；delivery note 明确 verification passed **不是** Lead acceptance 且**永不建议** accept/reject/repackage，已请求但未 settle（`deliveryRequested:true`/`deliveryAvailable:false`/无 verification·failure）投影为 `delivery.waiting` 而非 `not_requested`；diagnosis note 只陈述事实、不给处方。只读 MCP resources：`wao://semantics`（summary：每个 id + meaning）与 `wao://playbooks` 同等；`wao://semantics/{id}` 为 ResourceTemplate 详情（**不**把每个 detail id 注册为独立静态 resource）。未知/畸形 id 返回固定安全文本且**不回显请求 id**。MCP adapter 在严格 output parse 前立即 attach notes；output schema 的 `id` 用**有界 shape**（冻结 namespace pattern + 长度，派生自同一 SSOT）而非完整 catalog enum——避免每个 outputSchema 重复序列化 33+ id 的 enum 撑大 tools/list wire；application validator（`ID_SET`）仍是 catalog 成员的唯一权威（每个 selector 只发 catalog id）。错误响应保持固定且无 structuredContent；`run_delivery_review_bundle` 嵌入的 nested delivery BASE **不含** semanticNotes。工具面恰好 23，既有 playbook resources 与工具描述不受影响（描述只说 semanticNotes 自解释当前事实 + 详情在 `wao://semantics/{id}`，不复制目录措辞）。
- **三钟分离**：WAO 有三个互相独立的时钟，职责不重叠、互不覆盖：(1) **派发侧等待窗（waitTimeout，默认禁用；是观察预算而非执行死线）**——Lead 一次调用愿意花多少注意力等待的上限；到期只写 `run.observation_deadline_reached` 观察事实并通知（前台 CLI 打印一行指引；`run_wait` 窗口到期 exit 0 即此形），**绝不终止 worker**——终止只剩 Lead 显式 stop 与既有硬安全线（tokenBudget/workdir_escape）。(2) **后端请求超时（backend request timeout，独立）**——单次后端调用（HTTP/进程 spawn/collect 拉取）的网络/IO 超时，与 run 生命周期正交，按 `config.timeout` 链生效。(3) **Lead 观察等待（`run_wait` 的 `waitMs`）**——Lead 侧 long-poll 阻塞上限（下限 180s），只决定 Lead 一次调用等多久，**不影响 worker 生命周期**。三者解耦：到时只返回当前 liveness/通知让 Lead 决策，不杀 worker。
- **retained-candidate recovery**：`run_delivery_repackage` 内核支持 `disallowed_scope`、`backend_failed`、`process_missing` 三类闭集 provenance。`backend_failed` 只在绑定 delivery run 以 `backend_error|backend_stream_ended` 唯一失败、runtime 已 `run.stop_verified`、无冲突事实、worktree 仍在 exact base 且完整非空 inventory 可证明时投影；`process_missing` 恢复有两形：非终态孤儿（owner 心跳证明 runner 已消失，`run.process_missing_confirmed` 等 durable 事实）由显式 `run_delivery_repackage` 收口；或先经 `runs settle` 结算成终态 failed、再显式 `run_delivery_repackage` 恢复。WAO 只机械保全并重封装候选；`allowedPaths` 和语义接受仍完全由 Lead 提供，系统不自动扩域、重试 worker、恢复 provider session 或作 decision。
- **repackage CAS 政策错误**：`transcript.js` 的 `RepackageCasPolicyError` + 冻结 `REPACKAGE_CAS_POLICY_CODES` 是 application `REPACKAGE_REJECTION_CODES` 的子集；application 在审计边界内按类型和码双判转换。CAS 锁内读失败直接重抛；未知码/普通错误不转换，事件集不变。
- Backend 只负责 worker runtime。
- Skill 是 Lead 指导层（`SKILL.md`），不在运行时依赖图中保存状态。
- Transcript 是 run truth SSOT。等价的 state-changing operation（无论来自 MCP 还是 CLI）必须调用同一 service，产生相同 transcript durable facts 和 outcome；read-only query 不制造 transcript 事件，返回语义等价的结构化结果。

**依赖方向**：上层依赖下层，下层不知道上层。横切层只读 transcript + 发事件，不参与调度决策。

**Worker 输入不变量**：
- Lead 的 `SKILL.md`、roadmap、跨 worker 上下文和编排职责**不得注入 worker**。
- Worker 接收 bounded task prompt。
- Worker 可以接收稳定 role contract 和必要安全/运行时约束。
  - **角色合同注入**：由 **backend 能力声明** 驱动——RunManager 仅当 `backend.supportsRoleContract === true` 才允许带角色（严格相等，字符串/数字/对象/null/undefined 一律 fail closed），**不按 runtime 名称分支**。`systemPrompt` 路径由共享 `roleContract.js` 的 `resolveRoleContractPath` **相对 WAO 安装根**（从模块 URL 推导，非 `process.cwd()`）解析，所以同一份全局 registry + 角色文件可从任意目标项目目录使用。**加载时序**：start 在创建 transcript 和 spawn 前加载验证角色；resume 在读取既有 transcript 后、任何 append/spawn 前加载（失败时 transcript 字节不变）。不支持注入的 backend 配了 `systemPrompt` 在这两个时点 fail-closed（start 抛错、resume 显式抛错而非静默 return null）。八个 backend 各自注入：claude-code 用 `--append-system-prompt <内容>`（恰好一次，用内容不用路径以消除 TOCTOU）；codex 用 `-c developer_instructions=<安全 TOML 字符串>`（append 到 developer message，不替换 base instructions）；kimi-code 与 kimi-web 用固定分隔组合 role+task（role 在前 task 在后各恰好一次——**不是系统级权限隔离**，是 prompt 级引导）；deepseek-harness 用 `DSH_SYSTEM_PROMPT`；deepseek-acp 用 per-dispatch `--patch` personaPrefix；zcode 拼进 `session/send` content 前缀；OpenCode 须 serve healthy 且版本 ≥ 1.18.0（派发前运行时探测），用 message API 原生 `system` 字段，task 仍只在 user text part 出现一次。注入条件逐 backend 见 `src/backends/factory.js` 能力说明（生成面 `docs/surface/`）。runtime 差异只存在于 backend 内，共享 orchestration 不按 runtime 分支。Lead/model 不能通过 MCP/CLI 覆盖角色（run_dispatch strict schema 不接受 `systemPrompt`/`roleContract`/`rolePath`）。**WAO 不把角色合同保存为 `prompt.sent`/控制面输入**——transcript 只持久化原始 task prompt。（注意：worker 输出可能在回答中引用或复述角色内容，这由模型决定，因此不能宣称 transcript 永远不含角色正文。）
  - **canonical worker identity**：身份闭集 SSOT 是 `src/canonicalAgentId.js`（`isValidCanonicalAgentId` + `safeProjectAgentId`：合法字符仅 `[A-Za-z0-9._-]`、长度 1..128；dependency-free、root-level）。`roleContract.js` 的 `composeRoleContractWithIdentity` 是唯一组合函数，**只接受已验证的 canonical id**——非法 id（含 newline/whitespace/injection）不得以任何形式进入模型提示词（不"压成同一行"，而是直接拒绝加身份头，只返回角色正文）。start 和 resume 都走它，结果一致、角色合同恰好注入一次。只有本就配了角色合同的 agent 加身份头；未配 systemPrompt 的行为不变。身份头不伪装成 Lead task prompt（`prompt.sent` 仍只存原始 task prompt）。registry normalization（`registry.js`）用同一 SSOT：非法 registry id 在 transcript/spawn 前以**固定安全错误**拒绝（不回显恶意 id；是配置合法性校验，不是语义门禁）。结构化身份提取是 `transcript.js` 的 `extractCanonicalAgentId(events, expectedRunId)`：**只有每个事件都具备与 `expectedRunId` 一致的 `runId` 且同一个合法 canonical agentId** 才返回该 id；缺失、冲突、非法或跨 run 一律返回 `"unknown"`（不抛错、不伪造身份、不是自动停止门）。status/wait/collect 传入其请求 runId，并复用各自已读的同一份 transcript 快照（身份不额外读 transcript/registry/文件系统）。`run_dispatch`/`run_status`/`run_wait`/`run_collect` 的 MCP output schema 都用共享长度/字符合同声明 `agentId`、根对象 strict，并返回 `OUTPUT.parse(payload)` 的结果；malformed/extra/超长/injection service output 折叠为既有固定安全错误。
  - **worker evidence discipline**：同一 SSOT 组合函数 `composeRoleContractWithIdentity` 在身份头与角色正文之间恰好一次地注入一个固定的控制面所有证据纪律块（导出常量 `WORKER_EVIDENCE_DISCIPLINE`；唯一正文权威在 `src/application/roleContract.js`，本段只述语义不复制正文）。(1) **WQ-01 grounding**——对仓库路径/端点/符号/模块/API 形状/测试行为做具体断言前，先检查相关仓库证据，并在最终报告中给出支撑的 repo-relative 路径/符号/测试；未验证的断言必须显式标为 unverified/uncertain，不得当事实陈述。(2) **WQ-02 async/state**——改动 async/有状态 UI 或 query-gating 行为时，枚举适用状态（normal、loading、error、missing、unparseable、stale-data-plus-error），测试每个适用状态及高风险组合；省略某状态须说明为何不适用。该块是 **worker 执行/汇报纪律，不是语义验收规则**：不引入 parser、scorecard、自动重试/自动打回、自动门或接受决策，**Lead 仍是唯一语义裁判**。只对已有非空 role contract 且 agentId 合法的 worker 生效（start/resume 同一 SSOT，恰好一次）；无 role contract 或非法 agentId 行为不变；块随既有 roleContract transport 注入，不新增能力门，也不强制不支持 role 注入的 backend 承载它；六种正式 canonical 身份的组成串除 agentId 令牌外逐字节一致（无 runtime 名称/worker 席位分支）。
- Transcript 与控制面仍由 WAO/Lead 所有。

---

## 2. L1：运行时抽象

> **本章是 "runtime-agnostic" 承诺的技术落点**（定义见 `docs/01-prd.md` §1）。
> 强承诺：控制平面（L2）不针对具体 runtime 写分支——同一套 RunManager / 状态机 /
> scorecard，对所有 runtime 一视同仁。加新 runtime = 写一个 Backend 类 + parser，
> 控制平面一行不改。本章定义的就是这个承诺赖以成立的接口契约。

### 2.1 Backend 接口（核心）

八个 runtime（opencode-serve / claude-code / codex / kimi-code /
deepseek-harness / deepseek-acp / kimi-web / zcode）实现同一接口。
上层只面对这个接口，永远不碰传输细节（HTTP / stdio）。

```js
interface Backend {
  // 建会话 + 投递任务，返回 RunHandle
  spawn(agent: AgentDef, task: TaskInput): Promise<RunHandle>;

  // 拉取历史消息（用于恢复 / collect）——HTTP serve 型 backend 提供
  messages?(...): Promise<MessagePage>;

  // 健康检查——HTTP serve 型 backend 提供
  healthCheck?(serveUrl: string): Promise<HealthResult>;
}
```

```js
interface RunHandle {
  backendSessionId: string;              // backend 侧会话标识
  messageId?: string;                    // 投递的消息 id（若 backend 支持）
  // 统一消息流：屏蔽 HTTP 轮询 / stdio 流式差异
  events(signal?, opts?): AsyncIterable<RunEvent>;
  abort(): Promise<void>;                // 停止此会话
}
```

> **能力标志（provider 中立契约）**：Backend 声明静态布尔能力，闭集七轴：
> `supportsRoleContract`（角色合同 argv 注入）、`supportsSessionReuse`（provider
> 原生会话复用）、`supportsInFlightCorrection`、`replayByRespawn`、
> `reportsTokenUsage`、`reportsCommandExitCode`、`enforcesWriteSandbox`。RunManager 在 spawn 前做能力驱动
> 校验（fail-closed，不静默降级），读取严格 `=== true`——未声明一律读 false。
> 共享编排代码只读这些布尔值，**不**按 runtime 名/agentId 分支。逐 backend 的
> 七轴值与条件说明见生成层 `docs/surface/certification.md`。

### 2.2 RunEvent（统一事件流）

无论 opencode 的"轮询 /message"、claude-code 的"读 stdout"还是 ACP 的
JSON-RPC 通知，在 Backend 实现内部被翻译成**同一个事件序列**。

```js
type RunEvent =
  | { kind: "message", role: "user"|"assistant"|"system", parts: Part[] }
  | { kind: "tool_use", tool: string, input: unknown }
  | { kind: "tool_result", tool: string, output: unknown, isError: boolean }
  | { kind: "command", command: string, exitCode?: number }   // agent 跑的 shell 命令（证据链用）
  | { kind: "write_intent", path: string, toolCallId: string,
      correlationStatus: "tracked"|"missing_tool_call_id"|"duplicate_tool_call_id"|"pending_limit" }
                                                               // 尚未确认成功的写入意图（containment telemetry）
  | { kind: "file_written", path: string, toolCallId?: string } // runtime 已确认成功的写入（证据链用）
  | { kind: "thinking" }                                      // payload-free reasoning heartbeat
  | { kind: "runtime_activity",
      status: "initialized"|"streaming"|"provider_retry"|"process_active"|"files_changed"|"serve_active" } // payload-free
  | { kind: "metrics", tokens?: TokenUsage, costUsd?: number, durationMs?: number }
  | { kind: "done", reason: "completed"|"failed", error?: string, marker?: "completed_empty" };
```

```js
interface Part {
  type: "text";
  text: string;
}
interface TokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}
interface MessagePage { data: Message[]; cursor: { previous: string|null; next: string|null }; }
interface HealthResult { ok: boolean; status?: number; error?: string; }
```

**关键**：`command` / `file_written` / `tool_use` / `tool_result` 这几个事件是
scorecard 证据链的来源。`write_intent` 只表示 runtime 请求写入某路径，不能当作写入
成功证据；只有与同一 `toolCallId` 关联的成功结果才能确认 `file_written`。无法关联、
重复或超过 pending 上限的意图在 delivery 模式下 fail closed，不把不确定性投影成
成功。Backend 实现有责任从 runtime 的原始输出里**提取**这些结构化证据（而非原样
透传文本）。`runtime_activity` 是严格闭集、零 payload 的活性投影：provider 原始
stream delta、retry error、session/model id 和延迟数据不得进入 RunEvent。
`done.marker` 闭集 `{completed_empty}`，只挂在 completed 上：传输成功但没有可用效应
（非空白 assistant 文本 / command / file_written / tool_use / tool_result）绝不读作
普通成功——thinking / runtime_activity / metrics 是传输活性，不是可用效应。abort
的终态 aborted 属 RunManager 状态机（§4），不是 done 事件的 reason。
`cacheRead`/`cacheWrite` 与 `reasoning` 是不同计量维度；Claude 的 cache creation
token 不得伪装成 reasoning token。

### 2.3 AgentDef（registry 条目规范化后）

```js
interface AgentDef {
  id: string;                    // canonical：[A-Za-z0-9._-]，1..128
  backend: "opencode-serve" | "claude-code" | "codex" | "kimi-code" | "deepseek-harness"
         | "deepseek-acp" | "kimi-web" | "zcode"; // 闭集：成员增补属 Owner 决策，评估过的候选与裁定见 ADR-0028
  cwd: string;                   // 必须是非空字符串
  // opencode-serve：serveUrl 与 model.{providerID,id} 必填；agent（agent 名）、
  // model.variant 可选
  serveUrl?: string;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
  // kimi-web：serveUrl、model.id、tokenEnv（bearer token 的 env 名）必填；
  // kimiHome、serveWorkspaceDir 可选（绝对路径）
  tokenEnv?: string;
  // 进程式 backend（claude-code / codex / kimi-code）：binary、args 可选
  // （缺省走 PATH）；serveUrl/model 非必填
  binary?: string;               // zcode 必填：zcode.cjs 绝对路径（桌面更新会改安装路径）
  args?: string[];               // 额外启动参数；zcode 的 model.id 必填且为
                                 // <providerId>/<modelId> ref 形状（恰好一个 "/"，两段非空）
  // deepseek-harness：dshConfigPath（可读 Cordis config）与 credentialEnv 必填；
  // dshProvider 可选（缺省 deepseek-official）
  dshConfigPath?: string;
  credentialEnv?: string;        // 只声明 env 名，值不进 registry
  dshProvider?: string;
  // deepseek-acp：credentialEnv 必填；组合面固定为 dsh --profile acp
  // --patch <containment> --patch <role-contract>——dshConfigPath/dshProvider 是
  // 旧线字段，本线不用；binary 可选（缺省 dsh）；model 块只收 { id, providerID }，
  // reasoning.effort 只收 low / high / max，其余由 validateAgentPolicy 拒绝
  // sessionReuse：闭集。当前唯一成员 "lead_workspace"——同一 MCP Lead 会话在同一
  // 同一 Git workspace（按调用目标）内再次询问同一配置的专家时，复用 provider 会话
  // 上下文/cache，但每次仍开一个全新 WAO run/transcript 做独立监督。
  // null/缺省 = 每次开全新 provider 会话。
  sessionReuse?: "lead_workspace" | null;
}
```

`registry.js` 的 `normalizeAgent(id, agent)` 是条目规范化的单一真相：校验 id 形状、
backend 闭集成员与各 backend 必填字段；错误固定安全形状，不回显原始 id。
`readRegistry` 句柄提供 `listAgents()` / `getAgent(id, overrides)`（严格路径，与
CLI `registry validate` / `registry list` 一致：遇首条不可 normalize 的条目即抛错）
和 `rawEntries()`（未过滤、未 normalize 的 `[id, rawConfig]` 对）。

部分投影：`getRegistryInventoryWithIssues({registryPath, runDir, ...})` 逐条
normalize——有效条目经共享 `projectInventoryEntry` 与严格路径**逐字同形**投影
（CLI/MCP parity）；失败条目投影为一条有界安全 issue（闭集
`code ∈ {invalid_id, invalid_configuration}`；`agentId` 仅 canonical 时投影否则
`null`；绝不回显原始 id/error 文本/配置/路径/凭据；上限 `REGISTRY_ISSUES_CAP=32` +
`issuesTruncated`）。返回 `{agents, issues, issuesTruncated}`。整表源不可读或非法
JSON 仍由 `readRegistry` 抛错——另一类失败，绝不伪造成部分结果。MCP
`registry_list` / `lead_preflight` 走此部分路径；registry 源每次操作只读/解析一次，
`lead_preflight` 复用 `registry_list` 同一快照、绝不二次读取。WAO 始终 advisory：
部分结果从不 auto-stop 派发、从不换 worker、从不把坏条目标记 healthy。

### 2.4 Backend 工厂

`src/backends/factory.js` 的 `backendFor(agent)` 是唯一构造工厂：闭集每个成员返回
对应 backend 类（opencode-serve / kimi-web 构造可注入 fetch；claude-code / codex /
kimi-code / zcode 注入 waoCliPath；deepseek 两线零参构造），未知 backend 抛错。
所有构造点（daemon / backgroundRunner / commands 层）共用它；构造零副作用。
`backendCapabilitySnapshot(agent)` 静态构造并读取闭集能力声明（未知 backend →
null，能力面不猜）。

### 2.5 ProcessBackend（进程式 runtime）

驱动"一个进程 = 一次会话、stdout 流式产出"的 runtime（claude-code / codex /
kimi-code）。zcode 是独立的 `ZcodeBackend`（`src/backends/zcode.js`），不继承本类。

```js
class ProcessBackend implements Backend {
  constructor({ parserClass, buildArgs }) { ... }
  async spawn(agent, task): Promise<RunHandle> {
    // 1. 启动子进程：spawn(binary, [...args, ...buildPromptArgs(task.prompt)], { cwd: agent.cwd })
    // 2. 用 parser 把 stdout/stderr 流翻译成 RunEvent
    // 3. 进程隔离：Node 内置 Windows Job Object（父进程终止 → OS 杀全部子进程树，
    //    §4.3）+ abort 时 taskkill /pid /T /F 主动杀树
    // 4. 返回 RunHandle，events 来自 parser 的输出流
  }
}
```

**parser** 是 ProcessBackend 的核心差异点：不同 runtime 的 stdout 格式不同，格式
逻辑全在注入的 parserClass（`src/backends/parsers/`：claudeCode / codex / kimiCode /
lineStream）。提取不到结构化证据（如 tool_use）时降级为 message 事件，不让整个
run 失败——降级而非崩溃。

**parser 契约**：
```js
interface StreamParser {
  feed(chunk: Buffer|string): RunEvent[];   // 喂入 stdout chunk，吐出解析出的事件
  flush(): RunEvent[];                        // 流结束时收尾
  failureReason?(): { runtime, message } | null; // 可选：非零退出且没产出 done 时拼进报错的失败原话（先脱敏后截断）
}
```

`EventQueue` 必须先排空消费者暂停期间到达的事件，再兑现 closed：快速子进程可能在
RunManager 等待 transcript I/O 时就产出 `message` + `done` 并退出；队列已 closed
不构成跳过 `done` 的理由。

**worker 环境与输出边界**：
- 进程式 worker 不整体继承 `process.env`。backend 只拷贝固定的 OS/runtime 允许
  名单、分配给该 backend 的凭据通道、非密钥名的 `agent.env` 和 WAO 控制变量。
- `agent.env` 禁止密钥形状的名字；registry 只声明继承的凭据通道名，不存凭据值。
- 显式分配的凭据通道的值一律脱敏（不管通道名）；密钥形状环境名（含代理 URL）下
  不短于 8 字符的值，在事件进入 RunManager 内存前、JSONL 落盘前、以及
  raw-capture/stdout/stderr 诊断汇里做精确匹配脱敏。raw capture 用 UTF-8 流式
  脱敏器：跨 chunk 或码点字节拆开的值也能移除。
- backend 可声明纯字符串 `runtimeEnv(agent, task)` 控制变量；该钩子不承载凭据。
  Claude Code 用它对所有 WAO worker 禁用 runtime 内建 subagent 与 auto-memory，
  并仅在 delivery mode 禁用 runtime 自带 Git instructions，避免绕过 WAO 的派发与
  commit 所有权。
- 这是暴露面收敛，不是强隔离边界：同一 OS 身份下的 worker 仍能查看自己的运行时
  凭据或凭据文件。强隔离需要 broker/身份边界（为什么见决定 0015）。

#### 2.5a DeepSeekHarnessBackend（DSH JSON-RPC 线）

不解析人类 TUI，也不依赖 DSH GUI 当前选中的 preset。启动由用户单独安装配置的
`dsh-jsonrpc-agent`，以 stdio JSON-RPC 调用 `initialize` 和 `session/prompt`，再把
绑定当前 `sessionId` 与 prompt receipt `messageId` 的通知投影为同一套 `RunEvent`。
只有已绑定 receipt 之后的 assistant/message、tool、usage 和 turn/end 才可进入
WAO transcript；对应 idle 才完成 run。transport 提前关闭、runtime identity 不符、
未绑定事件或 DSH 内部 subagent 活动均 fail closed。

DSH 只拥有单次模型/tool loop；WAO 继续独占 worktree、transcript、stop、delivery、
verification 与 Lead decision。该 backend 不支持 provider session reuse，也不支持
运行中 correction；恢复只能把 durable prompt 重放到新 DSH 进程。车道配置与适用
限制见 `docs/usage/lanes.md` 与 `docs/certification-runbook.md`。

#### 2.5b DeepSeekAcpBackend（DSH ACP 集成面）

`DeepSeekAcpBackend`（`src/backends/deepSeekAcp.js`）驱动上游 shipped 的
`dsh --profile acp --patch <containment> --patch <role-contract>`，经 stdio 讲 ACP
（JSON-RPC 2.0、换行分隔）。与 §2.5a 的 WAO 自建 composition 并存：旧线保留至
新线认证通过，之后由 Owner 决定去留（为什么见决定 0031）。

- **协议面**：`initialize` / `session/new` / `session/prompt` / `session/close`
  （abort 路径加 `session/cancel`，真取消）。`session/prompt` 的响应只在整轮结束
  时到达，spawn 在握手后即返回 handle；过程中事实经 `session/update` **通知**投影。
  服务端→客户端请求 `session/request_permission` 必须应答，且受**会话与终态**约束：
  非本次绑定 sessionId、或终态已排队 → cancelled（绝不 allow）并留痕；其余按——
  选项含 `allow_once`/`allow_always` → 选中；仅 reject 类或未知 kind → 选中 reject
  （无 reject 可选 → cancelled，绝不授予）；无可选项 → cancelled。每次应答以
  system message 事件进 transcript 供审计（system 消息不是 usable effect）。
- **containment**：操作员安装的 `~/.wao/runtimes/dsh-acp/wao-contain.patch.yml`
  （内容依据 = 仓库内 `scripts/reliability/dsh-acp/wao-contain-safe.patch.yml`）在
  preflight 与 spawn 双重校验；缺失或与声明不匹配 → 拒绝派发（fail-closed）。
  WAO 只 detect / invoke / report，不生成、不升级、不持久修复。compose 层
  `disabled` 是唯一真 containment；这不是 OS 级沙箱隔离。
- **角色合同**：per-dispatch OS temp 独占目录（`wao-dsh-acp-*` 前缀）里的
  `--patch` 覆盖 `system-prompt.personaPrefix`，结构化序列化（标量经 JSON 转义），
  无凭据、不进 transcript；backend 实例 finally/stop 路径清理，启动时 best-effort
  清扫陈旧孤儿目录（只删本前缀目录，绝不触碰 runtimes/ 与会话存储）。
- **事件投影**：`agent_message_chunk` → assistant message；`agent_thought_chunk`
  → thinking；`tool_call`（`title` 即工具真名）→ tool_use，文件写类另发
  write_intent，shell 类在终态发 command（退出码能提取才带，不伪造）；
  `tool_call_update` 终态 → tool_result，write 类**关联成功**才发 file_written，
  `pending`/`in_progress` 绝不当作成功；`toolCallId` 缺失/空 → 关联不可靠
  （§2.2 不可靠关联态）：不发 write_intent、不发 file_written，证据降级为
  tool_use 并留痕；重复 `toolCallId` 的 tool_call → 拒绝覆盖待确认路径（首个关联
  保持），留痕；同一 `toolCallId` 重复/乱序终态取首个、后续忽略并留痕
  （handle.anomalies）；`usage_update` 是上下文占用观察，绝不计入 metrics 的
  input——终局用量唯一来源是 `session/prompt` 响应的 usage。未绑定 sessionId 的
  update 丢弃；未知 sessionUpdate 类型 / 未知 status → fail-closed 终态 failed。
- **终态映射**：`end_turn` → completed（无可用效应补 `completed_empty` 标记）；
  `cancelled` / `refusal` / `max_tokens` / `max_turn_requests` → failed（闭集码）；
  未知 stopReason 与断链（transport close 先于终态）→ failed，不投影为 completed。
- **二次校验 = tripwire（检测非阻止）**：wire 上出现 `subagent` / `subagent_fork` /
  `spawn_teammate` 工具调用即终态 failed——副作用可能已发生，这是检测不是阻止。
- **能力与 policy**：七轴逐值声明与条件见生成层 `docs/surface/certification.md`
  （含 `supportsSessionReuse=true` 的 lane/delivery 适用范围、
  `supportsInFlightCorrection=false` 时 run_correct 在派发层被拒）。这里钉派生
  不出的关联面事实：会话复用关联挂 transcript SSOT（opaqueUuid→routing 条目
  runId→前任何 `session.created.backendSessionId`），resume 信封只携带前任 WAO
  runId，ACP sessionId 由 spawn 权威按 runId 绑定读取器取回、in-process 送达
  （绝不进 argv）；关联缺失/损坏/上游拒绝一律 fail-closed 拒绝恢复，绝不静默
  新会话。`validateAgentPolicy`：provider 块拒绝（组合面固定 `--profile acp` +
  操作员 patch）；model 块只收 `{ id, providerID }`（ACP 的 model 值是 provider/model 二元组），
  会话建立时经 `session/set_config_option` 下发并核对回显，不一致即拒绝派发；不配
  model 时取 profile 缺省；contextWindow 等其它子字段拒绝；reasoning effort 只放行 WAO 六值闭集 ∩
  ACP 广告四档（off/low/high/max）的交集 = low/high/max（无证据支持映射，不
  发明），其余档位固定文案拒绝。派发时在 session/new 后、prompt 前下发，响应
  未确认请求值即 fail-closed 拒绝派发（不静默回退、不静默继续）；resume 轮
  不发 set，改用 session/resume 响应 configOptions 只读核对，不符即拒；下发与
  应答事实均以 system message 转录进 transcript。

containment 安装见 `docs/certification-runbook.md`「DSH 通道适用限制与能力交叉警告」，车道配置见 `docs/usage/lanes.md`；
wire 证据与复现资产见 `scripts/reliability/dsh-acp/`（evidence/*.json）。

### 2.6 OpenCodeServeBackend

HTTP 轮询型 backend。`spawn` 建会话并投递任务，返回
`{ backend, backendSessionId, serveUrl, cwd, messageId, admittedSeq, events, abort,
session, messages, sessionStatus }`。`events(signal, opts)` 是 AsyncIterable：内部
轮询 `/message` 填充；完成判定按 `completionMode`——缺省 `snapshot-stable`（快照
稳定），可配 `first-stable`（供会无限重复回答的模型）。消费方（RunManager 的
waitForCompletion）消费这条流直到 `done`，不是独立方法。`messages` 分页拉取历史
消息，`healthCheck` 探测 serve 健康。

### 2.7 KimiWebBackend 的 worker serve

kimi-web 车道指向一个本机 `kimi web` serve（`serveUrl`）。WAO 对这个 serve 的生命周期只做两件事，其余（状态、清扫、回收）是 `wao serve` 的手动命令，操作见 `docs/usage/lanes.md`「kimi 车道的 worker serve」：

- **按需拉起**（`src/backends/kimiServeStart.js` 的 `ensureServeRunning`）：车道声明了 `serveWorkspaceDir` 时，每次派发在建会话之前探一次回环端口；只有"连接被拒"才拉起。按端口的启动锁去重，有活着的 serve 进程就只等不拉，拉起后核对子进程落在哪个端口，落错就请它优雅退出。为什么见决定 0075。
- **空闲退出**（`src/backends/kimiServeIdleWatch.js`）：WAO 自己拉起的 serve（按需拉起、`serve recycle` 重启）带一个看护进程。启动看护的函数由调用方注入：kimi-web backend 交给按需拉起，serve 命令交给 recycle；只给本次拉起、应答正常、落在目标端口上的那个子进程配。
  - **判定：** 默认与归档两面会话列表都没有 busy / main_turn_active，且会话 id 集合不变，算空闲；读不到的拍不算空闲。
  - **关停：** 连续空闲满 30 分钟，抢同一把启动锁并复核仍空闲；关停前再核对端口上的实例仍是被看护的 pid，才请 serve 优雅关停。陈旧的锁只在确认持锁进程已不在时接管，认不出持锁者也不接管。
  - **退出：** 看护的退出原因是闭集 `IDLE_WATCH_EXIT_REASONS`。为什么见决定 0079。

两者都不杀进程。serve 的子进程环境剔除密钥类变量、`WAO_*`、`CLAUDE*` / `ANTHROPIC*`，并注入 `WAO_IN_WORKER=1` 与有效主目录（`stripServeEnvVars` / `kimiServeChildEnv`）。

---

## 3. Transcript（数据持久化）

每个 run 一个 JSONL 转录文件，每行一个 JSON 事件；Transcript 是 run 事实的唯一权威，恢复、scorecard、metrics、诊断都从事件重建，不依赖内存。新 run 写 `runs/projects/<slug>/<runId>.jsonl`，旧平铺 `runs/<runId>.jsonl` 只读兼容，定位一律经 `src/projectBuckets.js` 解析链。事件类型登记表见 `src/transcriptEvents.js`（人读清单为生成层 `docs/surface/transcript-events.md`）；迁移操作见 `docs/usage/transcript.md`。

### 3.1 事件结构

```js
interface TranscriptEvent {
  ts: string;            // ISO timestamp
  runId: string;
  agentId: string;
  type: string;          // 见 §3.2
  seq?: number;          // 单调递增序号，恢复定位续读；legacy 可缺席
  ...payload;
}
```

信封字段（`ts`/`seq`/`runId`/`agentId`/`type`）是权威的，payload 字段不能覆盖它们。payload、转移批次与转移 reason 在 append 前经过同一 secret redactor。

### 3.2 事件类型清单

事件名与说明的唯一可编辑真值源是代码里的登记表 `TRANSCRIPT_EVENT_REGISTRY`（`src/transcriptEvents.js`，冻结闭集）：每个事件一行——何时写、载荷约束、闭集指针、兼容说明，必要时带 legacy 标记。人读清单由生成层产出：`docs/surface/transcript-events.md`（`npm run gen:surface` 再生成，字节新鲜度由 `docsSurface.test.js` 守卫）。`docs/usage/transcript.md` 指向同一生成清单，不维护第二份表格。

写入侧守卫保证"代码写出的每种事件都已登记"：`src/transcript.js` 的所有写出口（公开 `append`、`transitionState` 的接受/拒绝两套批量、决定/repackage/verification/reverify/correction 的各 CAS 方法）共用一个事件序列化入口，序列化前查登记表。测试基建显式开严格模式（`WAO_TRANSCRIPT_EVENT_STRICT=1`，经 `buildCanonicalChildEnv` 对两个测试入口统一设置）：写出未登记类型立即抛错；被吞掉的异常写出由进程退出钩子置非零退出码。生产默认关闭：绝不丢弃事件，至多对每种类型警告一次。

`run.message` 不是落盘事件类型；它只是传给 scorecard 的 message 快照，因此不进登记表。

### 3.3 Transcript API

```js
class JsonlTranscript {
  constructor(filePath, context: { runId, agentId, initialSeq? }) {}
  async append(type, payload?): Promise<TranscriptEvent>  // 自动加 ts + seq
  async appendReadOnlyDeclared()                           // 只读声明恰一次（幂等）
  async transitionState(from, to, reason, options?)        // 原子终态仲裁（first terminal wins）
  async tryAppendDecision({ decision, reason })            // 原子 first-decision-wins
  // 其余 tryAppend*/tryClaim* 同款：append lock 内读-判-写
}
async function readTranscript(filePath): Promise<TranscriptEvent[]>
function findLatest(events, type): TranscriptEvent | undefined
function findLatestBound/findFirstBound(events, type, runId)  // runId 绑定读取
function findState(events): RunState        // 优先 run.state_change，legacy 按末事件兜底
function findLastEventSeq(events): number   // 续读点；legacy 无 seq 返回 0
```

终态仲裁与 stop 副作用所有权见 §4.1；delivery 决定面见 §4.9。

---

## 4. L2：控制平面

### 4.1 状态机

```
pending ── backend.spawn 成功 ──→ submitted ── 首个事件 ──→ running
running ── done 且 reason="completed" 且 scorecard 通过 ──→ completed
running ── done 且 reason="failed"，或 scorecard（hard）不通过，
          或硬安全线（budget_exceeded / workdir_escape 等）──→ failed
running ── abort() / stop ──→ aborted
```

```js
type RunState =
  | "pending" | "submitted" | "running"
  | "completed" | "failed" | "aborted" | "timed_out";
```

`timed_out` 不是可达终态。等待窗到期是通知不是终止（为什么见决定 0030）：到期只写 `run.observation_deadline_reached` 观察事实（见 §3.2）并通知调用方（前台 CLI 打印一行指引），监督继续到自然终态；终止只剩 Lead 显式 stop 与硬安全线。状态值保留在类型与 `TERMINAL_STATES` 中，仅为读取 legacy 转录（findState/诊断/投影不得回归）。

**转移规则（代码判定，绝不依赖 LLM）**：
- `pending→submitted`：`backend.spawn` 成功返回
- `submitted→running`：收到首个非 `done` 的 backend 事件。`message` 记 `first_message`；其余事件（`metrics`/`thinking`/`runtime_activity`/`command`/`tool_use`/`tool_result`/`file_written`/`write_intent`）记 `first_event`。`metrics` 落 `run.metrics`，其余照常落 `run.event`。首个事件就是 `done` 时直接收口，不经过 running。
- `running→completed`：收到 `done` 且 `reason==="completed"` **且 scorecard 通过**。scorecard 默认 warn：无 rules 时默认 `requireEvidence:warn`，不通过仅记 `scorecard.warn` 不转 failed（仍 completed）；`--scorecard-mode hard` 升级硬闸、`off` 关闭。
- `running→failed`：`done` 且 `reason==="failed"`，或 scorecard 不通过（hard 模式），或硬安全线触发（`budget_exceeded`/`workdir_escape` 等）
- `running→aborted`：`abort()` 调用

reason 写入侧闭集 SSOT：`STATE_CHANGE_REASONS`（`src/transcript.js`）。CLI `retry` 把任务重新派发为新 run，不把旧 run 转回 pending。

**每次转移写 `run.state_change` 事件**，含 `{ from, to, reason }`。

**跨进程终态仲裁**：状态转移经 `JsonlTranscript.transitionState` 在 append lock 内原子完成（读事件 → 检查既有终态 → 分配 seq → 批量 append）。规则 = **first terminal wins**：transcript 已有终态（terminal `run.state_change`，或 legacy terminal fact）时，任何后续转移（含 `running`/`submitted` 复活）被拒，写 `run.state_change_rejected` 审计事件（不静默消失）。RunManager 决定合法转移（状态机策略）；Transcript 只负责跨进程原子提交与终态不可逆，不把状态机策略下沉到 L1。owner 进程与短命 CLI 进程的终态覆盖竞态由此解决。

**stop 副作用所有权**：`stop` 先 `transitionState` claim `aborted`，只有 accepted winner 执行破坏性副作用（taskkill / backend.abort）；rejected loser 零副作用。`run.stop_requested` 不在 claim 前单独 append，而是经 `transitionState` 的 `attemptEvents` 同批提交（accepted: stop_requested → run.aborted{verification:"pending"} → state_change；rejected: stop_requested → state_change_rejected；持锁旧 events 不含本批 attemptEvents，不自拒绝）。winner 执行 kill/abort 后追加 `run.stop_verified`（进程已死，或服务端会话已确认静默）或 `run.stop_unverified`（进程可能仍活 + raiseAlert）。`verified` 以后置 PID 存活检查为准——taskkill exitCode=0 不单独产生 verified=true（PID 可能复用/僵尸）。`isPidAlive` 仅在 `ESRCH` 时返回 false；`EPERM`/未知错误保守返回 true（不得假验证）。taskkill 后有界轮询（`waitForPidExit`，默认 5 轮 × 200ms，可注入）补偿 Windows PID 回收延迟；耗尽仍 alive → unverified + raiseAlert。`run.stop_verified`/`run.stop_unverified` 写 `outcome`/`taskkillCalled`/`taskkillExitCode`/`processAliveBefore`/`processAliveAfter`（进程路径）或 `backend`/`method`/`taskkillCalled`（服务端路径），可重建"为何 verified"。

**停止路由按会话事实决定**，不按 backend 名分支：`proc_<pid>` 占位 id 与"provider 原生会话 id + `session.created.hostPid`"走进程树击杀；有 `serveUrl` 的走服务端中止（按会话的 backend 选实现，目标解析不出不 claim）；resume 重放（`run.rerun` 晚于 `session.created`）后停止目标取新进程；三者皆无 → 拒绝并提示手动结束 worker。Lead 面的 stop（MCP `run_stop`、CLI `stop` 共用同一 service）必须带 justification：`reason`（6–400 字符）是停止理由，`observedSeq` 是决定时看到的转录位置；位置之后落下的 worker 事件已超 2 分钟，或位置之后运行被重放过（停止目标已换）→ 拒绝，零事件、零副作用。不带 justification 的调用是内部/机制测试路径，不做这项检查。

**无效 PID 边界**：`stop` 在 claim 前验证 process session PID（`Number.isInteger(pid) && pid > 0`）。无效 PID（`proc_not-a-number` / `proc_0` / `proc_-1`）不进入 `processStop`、不 claim 终态、不 taskkill，保持 run 原状态；记录 `stop_requested` + `stop_unverified{outcome:"invalid_pid"}` + raiseAlert。CLI 输出 `stopped:false / outcome:"invalid_pid" / terminalAccepted:false / terminalState:<原状态>`——"metadata 损坏（backendSessionId 格式异常）"与"进程已退出（already_exited/verified）"由此区分。`isPidAlive` 探测函数可注入（`probe=process.kill`），测试不依赖真实 PID 环境。
### 4.2 RunManager

```js
class RunManager {
  constructor({ config, readRegistry, transcriptDir, backendFor,
                packageDeliveryFn, verifyDeliveryFn,
                userEnvReader, createWorktreeFn }) {}

  async start(agentId, options): Promise<Run>
  async resume(runId, options): Promise<Run | null>
  async abort(runId, reason?): Promise<void>
  async abortAll(reason): Promise<void>  // SIGINT / 进程退出时 abort 全部活跃 run
  list(): Run[]
}

interface Run {
  runId: string;
  agentId: string;
  state: RunState;
  transcript: JsonlTranscript;
  waitForCompletion(opts): Promise<WaitResult>;
  abort(reason?): Promise<void>;
}
```

`packageDeliveryFn`/`verifyDeliveryFn`/`userEnvReader`/`createWorktreeFn` 为可注入测试缝。

**start**：一切可判定的拒绝都在任何转录写入、worktree、spawn 之前（fail-closed、零副作用）——嵌套派发门、registry 读取与 `validateAgentPolicy`、角色合同能力门（`supportsRoleContract === true` 严格）、delivery 校验（须 persistent worktree 隔离）、sessionReuse/correctable 能力门、readOnly×delivery 互斥、派发 cwd 存在性、凭据可用性、调用预算 preflight（`preflightInvocation`）。通过后：建 transcript（runId 校验 + 分桶 decide-once）→ append `run.started` + `state_change(pending)` →（如隔离）建 worktree → `backend.spawn` → append `session.created` + `state_change(submitted)` → 注册 activeRuns → 返回 Run。options 家族：`prompt`/`cwd`/`tags`、`isolate`、`scorecard`/`scorecardMode`、`fireAndForget`、`requireCertified`/`certFreshnessDays`、delivery（见 §4.7）、`sessionReuse`（见 §4.10）、`correctable`、`readOnly`、`modelOverride`/`reasoningOverride`（与 requireCertified、sessionReuse 互斥）。

**resume**：读 transcript（分桶解析链）；已终态 → 返回 null。读取按 runId 绑定（`session.created`/`run.started`/`prompt.sent` 取绑定首条；无信封 legacy 转录拒绝）。delivery run 从 `run.started` 重建 delivery 上下文并经 `prepareDeliveryRequest` + `proveLinkedWorktree` 复验，失败 → null。进程类 backend 重放 prompt 到新进程（写 `run.rerun`）；HTTP 类重新 attach 会话。scorecard rules、model/reasoning 覆盖、角色（`run.started.rolePin` 钉住路径 + sha256 校验，漂移即拒）从该 run 自己的持久化事实重建。

**事件消费循环**（`start`/`resume` 内部启动，不阻塞调用方）：
```
for await (const ev of handle.events):
  transcript.append("run.event", ev)
  if state===submitted 且 ev 是 message/证据事件: state → running
  if ev.kind === "metrics": 预算闸检查（tokenBudget）
  if ev.kind === "done": 根据 reason 转到终态
  if ev.kind === "command" / file_written / tool_*: 记录证据（供 scorecard）
```

### 4.3 隔离

| 维度 | 机制 |
|------|------|
| 文件 | git worktree：每个 run 独立 worktree（`<sourceCwd>/.wao-worktrees/<runId>`，分支 `wao/<runId>`），按策略保留或清理；`.wao-worktrees/` 是 git exclude 稳定规则（worktree 删除后保留） |
| 进程 | Node 内置 Job Object（被动 OS 级：父进程终止→子进程全杀）+ `taskkill /T /F` 主动 abort；不实现自定义 Job Object（为什么见决定 0013） |
| 网络 | `src/portAllocator.js`：进程内端口记账（`allocate`/`release`，默认区间 [30000, 31000]，可选 `checkInUse` 占用探测，不持久化）；未接入任何 run 生命周期——没有按 run 分配端口的机制 |

**Worktree 策略与回收路径**（config 可选；解析优先级见 §8）：树的自动回收有四条路径。① `ephemeral`（readOnly 强制隔离用）——终态且停止确认后释放树，并回收零独有提交的 `wao/<runId>` 分支（`git branch -d`，best-effort；释放时不查脏）。② 交付验收——`run.delivery_accepted` 后释放线系树（tip/路径证明门控，分支保留）。③ `runs lineage-close`——线系关闭时释放成员树（分支保留）。④ 终态自动回收（只删树，分支一律保留）——普通 `persistent` 隔离树在 run 终态收尾（停止验证之后、`run.cleanup_done` 之前）自动释放；适用对象：派发时无 sessionReuse 路由、不是任何 run_lineage 线系成员、无绑定 `run.delivery_created`（打包成功的交付——undecided/rejected/accepted——一律不碰；打包失败而树全净的在适用对象内）。删除条件全部成立才删：树路径取自本 run 绑定的 `run.started.worktreePath` 且身份可证（父段名 `.wao-worktrees`、目录名即 runId、路径链无 symlink/junction、在 git worktree 登记、非源工作树、真实路径等于本 run 绑定 `run.started.cwd`（派发目录）真实路径下的 `.wao-worktrees/<runId>`——createWorktree 恒建在该处，从关联工作树派发的树同样可证、与绑定源仓库同 common git dir）；本 run 绑定终态已落盘且停止已确认；内容全净——`git status --porcelain=v1 -z --untracked-files=all --ignored=matching` 为空，被 ignore 的产物也算内容（与①不查脏的标准不同），skip-worktree/assume-unchanged/子模块等清点不了的形态一律保留；HEAD 附着在 `wao/<runId>` 且等于分支 tip（detached/漂移保留）；树下无嵌套运行树（在册或未登记但有内容）；不在使用中——删除前扫运行存储的全部转录（属主取文件名里的 runId；位置只认 runner 写下的 `run.started`，头读证得在树外就排除，其余整读、坏行跳过，已终态不占用）：别的未终态 run 的 `run.started.cwd` 或 `worktreePath` 在本树内（真实路径比较，win32 大小写折叠；不在盘上的路径按词法比较）→ 保留（`tree_in_use`，带占用者 runId）；没有可用 `run.started` 的未终态 run，提交时的 cwd 在本树内也算占用；位置证不了、存储读不出或路径解析出错也保留，记 `occupancy_unprovable`（fail-closed，细节见决定 0085）。任一条读不出或不成立就保留并记闭集原因（`run.worktree_release_skipped{reason}`）。删除用 `git worktree remove` 不加 force（失败或删后目录仍在记 `still_present` 保留）；`persistent` 树不满足条件时保留，便于检查产出。

**cleanup**（终态时确定性执行，幂等，失败记事件不抛错）：serve 类 backend 会话兜底 abort + 停止验证（验证失败告警，不阻断终态）；上游会话卫生（能力声明的 backend、仅 completed 的 run 释放上游 provider 会话；failed/aborted 的会话留作取证）；backend `dispose` 回收自建临时工件（如 native OAuth 隔离目录）；append `run.cleanup_done`（清理失败写 `run.cleanup_error`）。

### 4.4 调度 / 限并发（未实现）

没有调度器、信号量与优先级队列：并行度由调用方决定。

### 4.5 daemon 与可重入单进程

WAO 提供两种进程形态，共用同一套 RunManager/transcript 生命周期：

**可重入单进程（CLI）**：每次 CLI 调用读 transcript 恢复状态；前台 run（`run`、`spawn --wait`）进程存活期间持有活跃 run，Ctrl+C（SIGINT）abort。后台 run（`spawn` 不带 `--wait`、MCP `run_dispatch`）由 detached runner（`src/backgroundRunner.js`）承载：分离子进程（`detached` + `unref()`，提示词经 stdin 交接）驱动 `waitForCompletion` 并写转录，派发进程退出不影响它。运行、交付验证命令与 canonical 全量期间保持唤醒（`src/keepAwake.js`，决定 0093；`WAO_KEEP_AWAKE=0` 关闭）。

**持久 daemon**：`src/daemon.js` 是长期存活的 detached 进程，持有多个 in-flight run（复用 runBackground 核心驱动），经命名管道暴露窄协议 IPC（默认 `\\.\pipe\wao-daemon`，JSON-line over `node:net`：一行请求、一行响应；只在本机，不可远程触达；选型见决定 0012）。心跳写 runDir 的 handshake（`daemon.json`），CLI 重连判活；优雅退出清 handshake + 关 pipe。daemon start 内部走 `RunManager.start`，不按 backend 名分支。

### 4.6 Coder Delivery Contract v1

控制平面（而非 worker）负责把 isolated worktree 里的 worker 产出打包成 atomic delivery commit。worker 只准备变更，不创建 commit。

**模块边界**：`src/delivery.js` 是 deep module，只依赖 Node built-ins，不 import CLI / RunManager / transcript / backend / role 模块。Git 通过 `execFileSync("git", args)` 结构化参数调用，**禁止 shell-built command string**。

**API（v1）**：

```js
inspectDelivery(input) -> proposed DeliveryRef   // read-only, fail-closed
packageDelivery(input) -> committed DeliveryRef  // re-inspect + stage + one commit
```

**DeliveryRef v1**：

```jsonc
{
  "schemaVersion": 1,
  "kind": "git_commit",
  "runId": "run_...",
  "baseCommit": "<full hash>",
  "deliveryCommit": null,          // null = proposed; full hash after packaging
  "branch": "wao/run_...",
  "worktreePath": "<resolved path>",
  "changedFiles": ["repo/relative/path"],  // unique, lexically sorted
  "verification": {
    "status": "pending",           // pending | passed | failed | unavailable
    "commands": [],                // or "unavailableReason" when no verification
    "unavailableReason": "..."     // 与 commands 二选一
    // optional, append-only — present only when declared:
    //   "setupCommands": [...]     Lead-authored env prep, runs before commands
    //   "setupResults": [...]      per-setup-command safe facts (failed/passed paths)
    //   "environment": {"tempPerAttempt":true}   safe per-attempt temp-isolation facts (no paths)
    //   "failedPhase": "setup" | "assertion"   present on failed
    //   "verificationTimeoutMs": <ms>          per-command execution budget
  },
  "acceptance": {
    "status": "pending",           // pending | accepted | rejected
    "reviewerType": "lead_agent"
  },
  "integration": {
    "status": "pending",           // pending | integrated
    "targetCommit": null
  }
}
```

**写入边界**：delivery execution contract 将 process cwd / `WAO_TARGET_CWD` 声明为唯一授权 workspace。RunManager 对 backend 报告的 `write_intent` 与已确认 `file_written` 原始路径做词法 + realpath 边界判断（解析 junction/symlink；win32 先归一 MSYS 盘符路径）。Write/Edit/MultiEdit 类工具先产生带 opaque `toolCallId` 的 `write_intent`，只有匹配的成功 tool result 才确认 `file_written`；run 完成时仍有未确认写入意图也 fail closed。越界、无法关联或无法证明目标在 worktree 内时，写入不含路径的 `run.isolation_violation(code=workdir_escape)` 并在 packaging 前转 failed。物理位置无法证明前先对 EBUSY/EPERM/EACCES/ENOENT 短暂重试（最多 3 次）；重试后仍无法证明时，该事件附闭集 `errorCode`。该机制不解析命令文本，也不等同于 OS filesystem sandbox；backend 未报告的写入只能靠后续 artifact proof 发现。`enforcesWriteSandbox` 车道（codex）每次调用显式 workspace-write：可写面 = 工作目录 + 系统临时目录，活体证据 `sandboxEnforcement`。

**readiness 投影联动**：终端 delivery-requested run 且唯一较高优先级 delivery 事实为恰好一条 run-bound 安全 `isolation_violation` → `run_delivery` readiness 投影 `isolation_failed` + `isolationFailure:{code:"workdir_escape"}`（与 packaging failure 严格分离，无 candidateInventory/repackage/salvage/retry/stop/decision 面，Lead 只能另行派发）；缺失/多条/跨 run/非闭集 code → `ambiguous`。投影闭集与判定见 §1 `runDelivery.js` 条目。

**worker 可见的授权清单**：`composeDeliveryExecutionContract({allowedPaths})`（`src/application/roleContract.js`）把 AUTHORIZED WORK SCOPE 块附加到 delivery execution contract——单行 `AUTHORIZED_PATHS_JSON`（`encodeAuthorizedPathsJson` 转义 `U+2028/U+2029 与 DEL/C1（0x7F–0x9F）` 保证恒为一行，路径无法伪造新合同字段）逐字节声明 worker 开工前必须看到的精确写路径契约（segment-boundary 大小写敏感匹配 + 越界时 `SCOPE_EXPANSION_REQUIRED` 上报而非编辑）。块只声明 scope，不替换 packager——packaging containment 不放松。

**两道 containment 门**（时序分明，机械判定，不裁决语义、不自动 stop）：

1. **观察到的**写路径位于 isolated worktree **之外** → `run.isolation_violation(code=workdir_escape)`，在 packaging **之前**转 failed（readiness `isolation_failed`，无 packaging/decision 面）。
2. 位于 worktree **之内**但与 `delivery.allowedPaths` 不匹配或越出 path-segment boundary → packaging **期间**以 `disallowed_path` 拒绝（retained candidate 保留，`run_delivery_repackage` 无模型重封装）。

**Packaging ownership**：worker 不创建 delivery commit。`packageDelivery` 重新 inspect 后只 stage inspected 授权路径（`git add -A -- <changedFiles...>`），再用 Git **plumbing** 创建 commit：`git write-tree` 捕获 staged index tree → `git commit-tree <tree> -p <baseCommit>`（message 经 stdin，identity 经子进程 env 传 `WAO Delivery <wao-delivery@local>`）→ `git update-ref refs/heads/<branch> <candidate> <baseCommit>` 原子 CAS 更新 branch ref（expected-old-value 防并发）。

**Hooks 不参与机械打包**：`commit-tree` + `update-ref` 是 plumbing 命令，**不执行任何 repository hooks**（pre-commit / prepare-commit-msg / commit-msg / post-commit 均不运行）。Git hooks 属于项目验证策略，由 `DeliveryRef.verification.commands` 显式执行；机械 packager 确定性地把已检查的 index tree 变成 commit，不受项目 hook 配置影响。不修改 repo-local/global git config；GPG signing 不适用（plumbing 路径不走 signing）。

**Post-commit integrity gate**：`update-ref` 后统一验证八项不变量——(1) HEAD === candidateCommit，(2) parent = baseCommit，(3) `baseCommit..HEAD` 恰好 1 个 commit，(4) `HEAD^{tree}` === write-tree 输出，(5) committed files = inspected changedFiles（精确集合等价），(6) commit message 精确为 `wao-delivery: <runId>`，(7) author/committer 精确为 WAO process identity，(8) worktree 干净（`git status --porcelain=v1 -z --untracked-files=all` 为空）。ignored 文件不出现不影响成功。全通过才返回 DeliveryRef。

**Packaging failure cleanup**（三类失败路径）：
- **staging mismatch**：`git reset -q --` 恢复 index 到 base，保留 working-tree；验证 HEAD 在 base、index 为空。
- **commit-tree / update-ref CAS 失败**：`git reset -q --` 恢复 index（branch 未移动——CAS 保护），保留 working-tree；验证 HEAD 在 base、index 为空。candidate object 不可达但不影响 branch。
- **post-update-ref integrity 失败**：`git reset --mixed -q --end-of-options <canonicalBase>` 把 branch HEAD 移回 base（不用 `--hard`、不用 `clean`），保留所有 working-tree 文件内容，重新验证 HEAD === baseCommit 且 cached diff 为空；只有验证成功才声称 restored。

rollback 本身失败时抛 `deliveryCode=cleanup_failed`（保留原始失败类别/摘要，不吞错误、不虚报恢复）。

重复 packaging（HEAD 已在 delivery commit）被 base mismatch 拦截，不创建第二个 commit。

**Fail-closed**（inspection + packaging 均适用）：empty diff、dirty base（pre-staged changes）、disallowed path（不在 allowedPaths 或 path-segment boundary 越界）、non-Git path、primary checkout（非 linked worktree）、detached HEAD、wrong branch、base commit mismatch、ephemeral/non-persistent isolation、invalid runId（ref 注入/路径遍历）、invalid allowedPaths（空 segment/重复分隔符/根 "/"、"."、".."、绝对或盘符路径；**单个尾分隔符在写入口归一化放行**，段边界前缀语义，见 isPathAllowed）、invalid baseCommit（`--` 开头 option 注入）、whitespace-only verification — 均拒绝，不静默改写。

**生命周期**：
```
worker output → delivery_created → verification_passed|failed → lead_accepted|rejected → integrated
```
worker 进程完成 ≠ code delivery 完成。

### 4.7 Run delivery mode 集成

**RunManager.start() option**：

```js
delivery: {
  mode: "git_commit_v1",             // 目前唯一支持的模式
  allowedPaths: ["src", "test/"],     // SSOT 验证同 src/delivery.js
  verificationCommands: ["npm test"], // 或 verificationUnavailableReason: "..."
  verificationSetupCommands: ["..."], // 可选：assertion 前顺序执行的环境准备命令
  verificationTimeoutMs: 600000       // 可选：per-command 执行预算（整数 [1000,7200000]）
}
```

`delivery` 缺席：不产生任何 delivery Git 调用或事件，行为与普通 run 一致。
`delivery` present：`mode` 必须为 `git_commit_v1`，并要求 `{type:"worktree", strategy:"persistent"}` 隔离。
worktree 创建前先经 `prepareDeliveryRequest()` 验证（SSOT 在 `src/delivery.js`）：`allowedPaths`、`verificationCommands`/`verificationUnavailableReason`、`verificationSetupCommands`、`verificationTimeoutMs`（闭界整数 ms，`VERIFICATION_TIMEOUT_MS_MIN=1000`/`VERIFICATION_TIMEOUT_MS_MAX=7200000`，与 MCP zod 同源）。非法值在任何副作用前以 `invalid_verification` 拒绝；`verificationTimeoutMs` 仅在显式声明时持久化，缺失零漂移。
worktree 创建后、backend spawn 前捕获 base commit（full hash）。
`run.started` 扩展 `delivery: {mode, baseCommit, allowedPaths, verificationCommands|verificationUnavailableReason, verificationSetupCommands?, verificationTimeoutMs?}`（`verificationSetupCommands`/`verificationTimeoutMs` 仅当 Lead 声明时出现）。
`resume()` 从 `run.started.delivery` 重建 deliveryContext，并重新经同一 SSOT 校验。

**Packaging 时序**（`waitForCompletion` completed 路径内）：

```text
backend done:completed
  → scorecard (如有 rules)
  → hard scorecard failed: failed 路径，不打包
  → re-check external terminal
  → if terminal exists: loser result, no package
  → packageDelivery(deliveryContext)
     → success: transition completed
     → failure: transition failed
  → transition accepted: 返回成功/失败合同
  → transition rejected (race): 返回既有终态 + delivery/deliveryError 事实
```

**Terminal arbitration**（`transitionState`，first-terminal-wins）：
- `run.delivery_created` / `run.delivery_failed` 作为 `attemptEvents` 写入：无论 transition 被接受还是输给先到的外部终态，delivery 事实都落在同一原子批次里——不存在"delivery commit 已创建但转录无事实"的窗口。
- `run.completed` / `run.error{phase:"delivery"}` 是 `factEvents`：只在 accepted transition 中写入。
- Race（外部终态在 packaging 期间先赢）：返回 loser result，携带 `delivery`/`deliveryError`。不回滚已创建的 DeliveryRef（它是 isolated recoverable artifact）。

**`waitForCompletion` result contract**：
- 每个非抛出的 terminal result 都带一致布尔：`completed`、`failed`、`aborted`、`timedOut`——恰好一个为 true 且与终态一致。
- 成功：`{completed:true, failed:false, aborted:false, timedOut:false, messages, evidence, metrics, delivery}`——`delivery` 是完整 DeliveryRef。
- 打包失败：`{completed:false, failed:true, aborted:false, timedOut:false, messages, evidence, metrics, deliveryError:{code, message}}`——结构化非抛出。
- budget 超限、abort、hard scorecard fail 返回同一结构化 terminal 形状，且不调用 packager。accepted 的 backend failure 是例外路径：持久化 `run.error` + terminal `failed` 后抛出。
- 等待窗到期不是终态（为什么见决定 0030）：定时器是纯通知器（写 `run.observation_deadline_reached` + 回调 `onObservationDeadline`），不 abort、不产生 `timed_out`；到期后终态仍是自然的 completed/failed（或外部 stop 的 aborted）。`timedOut:true` 只对 legacy timed_out 终态转录出现（loser 结果沿用既有终态，读取兼容）。到期事实在 CLI/runner 结果上以 `observationDeadlineReached:true` 呈现（additive）。

**事件排序**：
- 成功：`scorecard.checked`（如有）→ `run.delivery_created` → `run.completed` → `run.state_change completed`（seq 连续）。
- 打包失败：`run.delivery_failed` → `run.error phase=delivery` → `run.state_change failed`（seq 连续）。

`packageDeliveryFn` 构造函数参数（默认 `packageDelivery`）仅供测试/组合注入，非通用 service container。

### 4.8 Delivery Verification 集成

**两个正交维度**：

Run terminal state（`completed`/`failed`/`timed_out`/`aborted`）和 delivery verification status（`passed`/`failed`/`unavailable`）是两个正交维度，不互相覆盖：

- `run.completed` = worker lifecycle done（backend 干净退出）。
- verification `failed` = verification commands 失败或 artifact 被改动。
- verification 可以在 `run.completed` 之后 fail，不改变 run terminal state。

**生命周期时序**（`waitForCompletion` 成功路径内，packaging 之后）：

```text
packageDelivery success → transitionState(completed)
  → run.delivery_created (attemptEvent) + run.completed (factEvent, atomic batch)
  → run.state_change completed
  → _runCleanup() (session abort; persistent worktree 不删)
  → _verifyDeliveryResult(deliveryRef)
     → 同机验证闸 gate.acquire() 先于任何 spawn（排队不计入预算；
        fail-open / kill switch / HELD 继承时无闸直通）— verifyDelivery 内部
        try/finally 恰好 release 一次
     → verifyDelivery(deliveryRef)    // exact-artifact proof + commands
     → transcript.append(verification_passed|failed|unavailable)
  → return {completed:true, delivery:verifiedRef, verificationFailed?, verificationUnavailable?}
```

**同机验证串行化闸**（`src/verificationGate.js`）：机器级租约（`%LOCALAPPDATA%\wao\verification.lease`，经 `machineGatePaths.js` SSOT）把生产路径发起的交付验证与直连 canonical 全量串行化——粒度 = 整个 verifyDelivery 命令序列 / 一次 canonical main()。入闸的生产路径：run 内验证（`waitForCompletion`）、`runs delivery reverify`、`runs delivery repackage`、`runs verify-commit`，经 `createCallerGate` 显式开启；canonical 全量（`scripts/canonical-test.mjs`）直接经 `createVerificationGate` 认领。只有依赖默认验证器的调用方入闸（注入 `verifyDeliveryFn` 的测试/内部复用零牵连），`gateEngaged()` 收口 kill switch（`WAO_VERIFICATION_GATE=off`）与防自锁（HELD 继承环境不认领）。排队/等待/降级永不改变验证结果语义、永不计入任何执行预算；`runs gate` 是只读查询 + 文档在案的人工破锁出口。运维语义见 `docs/usage/delivery.md` 场景 4b；症状路由见 `docs/troubleshooting.md` §8.1。

**Verification 的 proof 纪律**（`src/deliveryVerification.js`）：

1. **所有结果前先 proof**：passed/failed/unavailable 任何结果产生前，都必须先调 `assertCommittedDeliveryRef(deliveryRef)`。unavailable 路径（零 command）也不例外——脏/伪造的 worktree 必须被 `artifact_mismatch` 挡住。
2. **每命令后 re-proof**：每个 attempted command 结束后（exit 0、非零、timeout、launch error），都先重新执行完整 proof，再分类命令结果。
3. **artifact_mutated 优先**：若命令同时失败并造成 artifact mutation，`artifact_mutated` 优先于 `command_failed`/`command_timeout`/`execution_error`。
4. **不 reset/clean**：verification 不修改被命令改动的 worktree 状态（proof 是只读的）。
5. **setup 阶段与环境合同**：Lead 可选声明 `verificationSetupCommands`，在 assertion 命令（`verificationCommands`）之前**顺序**执行；setup 与 assertion 分开验证、持久化与投影，setup 失败投影为闭集 `setup_failed` / `setup_timeout` / `setup_environment_error`（**不**伪装成 assertion `command_failed`），不泄漏命令体/路径/stderr。每条 setup 与每条 assertion 之后都 re-proof，tracked artifact 或 lockfile 漂移 = `artifact_mutated`（setup 漂移时 assertion 不执行；`failedPhase` 标记 setup/assertion）。每次 attempt（setup 或 assertion 命令）创建唯一 temp 目录并注入 `TMP`/`TEMP`/`TMPDIR`，两个 attempt 不复用、不复用 worker temp，仅持久化安全布尔事实（`environment.tempPerAttempt`，不含绝对路径）。**依赖不继承**：worker / selected worktree 的 `node_modules` 等 ignored/untracked 依赖不会自动进入 exact verifier 环境——需要 Lead 声明 `verificationSetupCommands` 来准备。命令只来自 Lead 输入，不从 worker 输出推断。
6. **per-command 执行预算**（`verificationTimeoutMs`，Lead 可选）：Lead 声明时，`prepareDeliveryRequest`（SSOT）校验为闭界整数 ms `[1000, 7200000]`，默认 `300000` **仅在字段缺失时**应用（缺失时持久化零漂移——`run.started.delivery`、`delivery_created` ref、verification outcome ref 都不出现该键）。它是 exact verifier 的**逐条** setup/assertion 命令执行预算（与 `run_wait`/`run_await_result` 的 Lead 观察窗口正交，语义上**不是** observation budget）。持久值在所有转发面保留同一字段：start/resume（resume 重新经 SSOT 校验，持久值损坏 → resume 拒绝 null，零副作用）、profile 折叠（profile 只供命令，Lead 声明的预算保留）、MCP dispatch/continue/CLI 转发、reverify 继承（省略 `timeoutMs` 继承 ref 持久预算，持久值损坏 fail-closed；显式值同样过共享闭界）。执行超时结果投影为闭集 `command_timeout`/`setup_timeout`；**无自动加宽、无自动重试、无自动 stop/decision**。

**Transcript 原子可信语义**（`Run._verifyDeliveryResult`）：

并发控制（`_verificationComputePromise` / `_verificationAppendPromise` 合并 in-flight Promise）：

- verifier 计算通过共享 `_verificationComputePromise` 合并——任意数量并发调用只执行 verifier 一次。Promise 创建一次，所有 caller await 同一实例。
- outcome append 通过共享 `_verificationAppendPromise` 合并——任意数量并发调用最多成功 append 一个 outcome event。
- append 失败时，所有等待者收到同一个错误；`_verificationAppendPromise` 清空以允许显式重试。
- 重试 append 不得重跑 verifier（使用已缓存的 `_pendingVerificationResult`）。
- append 成功后 `_verificationRecorded=true`，后续调用幂等返回 `_recordedVerificationResult`。
- 不重新引入"未落盘却返回 pass"的 fallback。

错误分类（`_computeVerification`，strict `instanceof DeliveryError` 识别）：

- `DeliveryError`（artifact_mismatch 等已知 proof 失败）→ 转换为 verification failed result，**保留原 failureCode**（不降级为 execution_error，不原样抛给 waitForCompletion）。生成 `{delivery: {...ref, verification:{status:"failed", failureCode, verifiedCommit, results:[]}}, outcome:"failed", failureCode}`，由 `_verificationAppendPromise` 写入唯一 `run.delivery_verification_failed` event。waitForCompletion 返回 `completed:true + verificationFailed:true`，run terminal 保持 completed。
- 只有未知 verifier 内部异常映射为 `execution_error` result（不 re-throw）。
- **只有 transcript outcome append 失败才向调用者传播异常**——这是唯一的异常传播路径。
- 不泄露原始 error.message/stack/stderr/secret。
- strict `instanceof DeliveryError` 识别——不接受伪造的 `{name:"DeliveryError"}` 对象。

**身份 SSOT**（`src/delivery.js`）：

`assertDeliveryIdentity(cwd, deliveryCode)` 是 author + committer 身份检查的单一 SSOT，由 `verifyPostCommitIntegrity`（packaging，`commit_integrity`）和 `assertCommittedDeliveryRef`（verification proof，`artifact_mismatch`）共用。

`verifyDeliveryFn` 构造函数参数（默认 `verifyDelivery`）仅供测试/组合注入。

### 4.9 Lead Acceptance Record

**公开 CLI**：

```text
runs delivery <runId> [--format json]                                    # 只读查询
runs delivery <runId> --accept --reason-file FILE [--format json]       # Lead 接受
runs delivery <runId> --reject --reason-file FILE [--format json]       # Lead 拒绝
```

前台 `run` 命令以 `--delivery-spec-file FILE`（JSON，内层 delivery 对象）声明 delivery。`runs delivery` 另有只读 bounded wait（`--wait-ms N`）与 `review` / `reverify` 子命令；参数与输出形状见 `docs/usage/delivery.md` 和生成层 `docs/surface/`。本节只定义验收决策合同。

**只读查询**返回从 transcript 事件重建的结构化视图：runId、终态、最新 DeliveryRef、verification 状态/failureCode、acceptance 状态及已有决策事件（如有）。Transcript 是 SSOT，不创建额外 current-state 文件。

**决策前置条件**：
- 必须存在 exactly one committed delivery（有 `run.delivery_created`；有 verification event，或符合下述有界 pending 拒绝形态）。
- `--accept` 和 `--reject` 互斥。
- `--reason-file` 必须是非空 UTF-8 文件（不支持 inline reason，避免 PowerShell quoting drift）。
- `--accept` 要求 effective verification `passed` 且 run terminal `completed`；唯一例外是 **recovery accept**：终态 `failed` 的 run，若其持久失败恰好是 exactly one 绑定的 `run.delivery_failed`（code `disallowed_path`）、已被绑定到 created commit 的 model-free repackage 取代、且 verification `passed`，可以接受。recovery accept 不把终态 failed 改写成 completed。
- `--reject` 允许 passed/failed/unavailable verification，但仍要求 committed delivery。
- **有界 pending 拒绝**：`--reject` 额外允许「verification 仍 pending 且无任何 `run.delivery_verification_*` outcome」的形态，但仅当 run 已有**绑定的** `run.state_change → completed`（legacy 末事件推断不算——追加决策事件本身会变成末事件并把推断状态打回 running），且 `run.delivery_created` 的 DeliveryRef **显式**声明 `verification.status:"pending"`（缺失/未知/谎称终态的 legacy ref 不获得该资格）。该出口不推断验证进程生死、不中断验证、不伪造结果：迟到的真实 outcome（passed/failed/unavailable）照常落盘并在读面如实显示，acceptance 恒为 rejected。`--accept` 对 pending 一律拒绝（`verification_failed`）；`run_delivery_reverify` 资格不变（仍要求原始 verification failed）；repackage 资格不变。
- 决策本身不执行 merge/reset/checkout/cherry-pick/push/branch deletion。accepted 落盘后另行 best-effort 释放线系资源：上游 provider 会话（能力位门控）与线系 worktree（tip/路径证明门控，分支保留，delivery commit 可达性不丢）；释放失败只记事件，绝不逆转 accepted。

**事件**：append exactly one of `run.delivery_accepted` / `run.delivery_rejected`。
事件含新 DeliveryRef（acceptance.status 变为 accepted/rejected，其余字段不变）+ `deliveryCommit` + `reviewerType:"lead_agent"` + trimmed reason。
不重写已有 `run.delivery_created` 或 verification 事件。pending 拒绝的决策 ref 显式保留 `verification:"pending"` + `acceptance:"rejected"`——这正是读面校验的唯一合法 pending 决策形态。

**原子 first-decision-wins**（`JsonlTranscript.tryAppendDecision`）：
在已有 cross-process append lock 内完成：读事件 → **先经共享事实权威校验** → 返回已校验的已有 decision（`{accepted:false,existing}` loser，先于任何新动作 gate）→ append at most one decision event → 返回 `{accepted:true,event}` 给 winner。此原语窄，不泛化为编排引擎。
append 失败原样传播；不在 durable transcript write 前 report acceptance。
CLI JSON 区分 `decisionAccepted:true`（winner）vs `decisionAccepted:false` + existing（loser）。

**共享纯事实权威**（`src/transcript.js::validateDeliveryFacts(events, options)`）：
读面（`gatherDeliveryView` / `projectDeliveryReadiness` / `run_await_result` 终态 outcome）与锁内写面（`tryAppendDecision`）复用**同一**校验器，不存在第二套决策/重建算法。窄模式经显式 options 进入，默认单参调用行为字节不变（reverify/repackage 等默认单参 legacy 消费者不受影响；direct review 解析器 `resolveRunDeliveryReviewTarget` 以 `{expectedRunId}` 进入绑定模式）：

- `{expectedRunId}`（runId 绑定模式）：核心类别（`run.delivery_created` / 原始 outcome / `run.delivery_accepted|rejected`）绑定到请求 runId——**外信封事件被忽略**（属别的 run，不是冲突），但**先计数全部绑定事件再做 payload 检查**：重复、孤儿（有 outcome/decision 无 created）、或畸形的绑定事实一律 `delivery_malformed`。每个被消费的 ref 必须携带**canonical 且一致**的 `(runId, baseCommit, deliveryCommit)`；在场的顶层 `deliveryCommit` 与 `verifiedCommit` 必须一致（缺失的历史可选值不发明、不视为冲突）。原始 outcome 事件以 **closed-set 事件类型为状态权威**：内嵌状态缺失或仍为 `"pending"`（快照滞后）时以类型为准；内嵌状态声称**另一个终态或未知值**则是冲突。新写入的 decision 快照使用已经校验的 effective verification 状态，不照抄旧 outcome 的缺失/pending 状态；历史事件不改写。写入器在同一锁内用本校验器检查拟追加结果，只有追加后仍合法才写入。
- `{allowVerificationPending:true}`（pending 感知模式）：额外接纳「恰一条绑定可用 created + 零 outcome」为 valid-with-pending——但**仅当** created ref 显式声明 `verification.status:"pending"`。legacy 缺失状态（或无 outcome 却谎称终态）保持旧 `delivery_unavailable` 拒绝，不获得 pending 拒绝资格；读面仍照旧读作 pending（零漂移）。

**已有 decision 的校验**（绑定模式下唯一一条时）：
- 身份匹配（与 created 同一 canonical `(runId, base, deliveryCommit)`）；在场顶层 `deliveryCommit`/`verifiedCommit` 一致；内嵌 verification 状态必须**在场且已知**（缺失/未知恒为冲突）；acceptance 印记与事件类型一致——**窄 legacy 例外**：缺失或 `"pending"` 的印记仅在「非 pending 快照且有更早的匹配原始 outcome 或合法 reverify 背书」时允许（legacy C2 形态）。
- 每个 decision 都须在其前缀中已有同一 created；未来追加的 created 或 reverify 请求不得反过来证明过去的决定。新动作的终态权限只从当前 run 的绑定事件中读取。
- **非 pending decision** 必须在其 transcript 前缀（append 序，seq 缺失允许）中有更早的匹配原始 outcome 或完整合法 reverify 链背书；accepted 必须背书为 passed。
- **pending decision** 只能是 reject：显式印 `rejected`、created 显式声明 pending、更早存在绑定 `run.state_change → completed`、且决策前无原始 outcome（**之后的迟到 outcome 合法**）。pending 的 accepted 永不合法——迟到的 pass 也不能将其洗白（读面 fail-closed `ambiguous`，写面拒绝其充当已有决策）。合法 pending 拒绝之后的迟到 passed/failed/unavailable 在读面**如实显示该原始 outcome**，acceptance 恒为 rejected；reverify 链（projectReverifyChain 的特殊合同不变：任何外信封 reverify 事件仍是 malformed，绝不预过滤、资格不变）与 pending decision 互斥。

**读面语义**（point / readiness / await 三面一致）：
- malformed ⇒ `ambiguous`（或查询 throw），无任何 success 字段——await 的终态 outcome 以共享视图的 ambiguous 判定为准，不建第二状态机。
- **迟到 outcome 作为 verification 事实，已校验 decision 作为 acceptance 事实**；原始 verification 与 effective verification（reverify）保持区分。
- **pending 拒绝把 readiness 落为 `reviewable`**（存在持久决策）而 verification 仍显示 `pending`——不新增枚举/字段；legacy 缺失状态仍读 `waiting_for_verification`。
- `run_delivery_review` 的 exact-proof 资格不变（仍要求 verification outcome；pending 拒绝形态对 review fail-closed）。

---

### 4.10 Expert Session Reuse

同一 MCP Lead server 实例在同一目标项目内再次询问同一**配置了 `sessionReuse: "lead_workspace"`** 的专家（非 delivery）时，WAO 复用 provider 原生会话（如 Claude Code 会话）保留上下文/cache，同时**每次仍开全新 WAO run/transcript** 做独立监督。未配置该策略的 agent 保持现状行为。`deepseek-acp` 同样声明 `supportsSessionReuse=true`：关联事实挂 transcript SSOT；resume 信封携带前任 WAO runId，ACP sessionId 由 spawn 权威按 runId 绑定读取器从前任何转录取回、in-process 送达，绝不进 argv；缺失/损坏/上游拒绝一律 fail-closed，绝不静默新会话。

**复用身份（provider 中立）**：`MCP server instance identity + 本次调用的目标 cwd + canonical agentId` 三者经 sha256 派生为一个**不透明的 UUID v4**（设 version/variant 位）。该 uuid 是唯一进入 provider 的标识：claude-code 首轮 `--session-id <uuid>`，后续轮 `--resume <uuid>`。**绝不**把原始 Lead id / workspace 路径 / session id / agentId 经 MCP 返回或写入 provider payload——它们只停留在 dispatch 进程内。Host/MCP 重启产生新 identity，即新 provider 会话；本合同不宣称跨 Host 重启永久续用。

**每请求仍是新 run**：每次派发生成新 runId + transcript；绝不复用/追加一个已 terminal 的 WAO run。被复用的对象只有 backend 原生会话本身。

**严格非 delivery**：delivery 派发**总是**开全新 provider 会话，不复用 delivery worktree/session。`reuseEligible = effectiveReuse === "lead_workspace" && !publicDelivery`。生效政策经 `effectiveSessionReuse` 分级（显式 role 读 `config/roles.json[role]`；lane-only/裸派读席位兼容来源）；未登记角色不复用。

**SSOT**：`src/application/sessionReuse.js`（纯计算 + 有限路由事实落盘）。决策矩阵（`resolveReuseTurn`）：无历史→`first`；路由条目**损坏**（存在但不可解析/形状坏，含 epoch 在场但非非负整数）→**拒绝**（绝不静默 first，为什么见决定 0031）；prior run 非 terminal→`busy`（`fresh` 不旁路 busy——Contract 6 无例外）；prior terminal **严格 === completed** 且绑定 `session.created`（backendSessionId 非空字符串）→`resume`（信封携带前任 runId）；prior terminal 为 failed/aborted/timed_out（或不可投影）→**弃档**：槽位覆写 `first` 且 epoch+1（换代数 uuid——中毒会话绝不接着用；对 uuid 即 provider 会话 id 的通道，坏会话结构性不可达）；绑定 `session.created` 但 backendSessionId 缺失/空/非字符串→**拒绝**；terminal（completed）无 `session.created`（崩溃）→`first`（epoch 保持）；prior transcript 缺失且新鲜（<5min）→`busy`；缺失且陈旧→`first`+epoch+1（不可知=可能已中毒）。**fresh 逃生口**：per-dispatch `fresh:true`（MCP 参数；CLI 一次性 leadSession 本就永远 fresh）强制 `first`+epoch+1。`first`/`resume` 在 per-key 文件锁内 claim slot（条目 `{runId, updatedAt[, epoch]}`，epoch 缺席=0）；resume 信封 `{mode, opaqueUuid, turn, priorRunId}` 只携带前任 **WAO runId**；provider session id 由 spawn 权威经 `resolvePriorProviderSessionId` 从前任何转录取回、in-process 送达——**绝不进 argv**。

**epoch（会话代数）**：派生材料在 epoch ≥ 1 时追加代数行（epoch 0/缺席与旧 uuid 逐字节相同——存量会话零迁移）；keyHash **绝不**携带 epoch（槽位=身份锚点，跨代数稳定）。换代数=换 provider 会话；epoch 只活在路由条目与派生材料，不进转录审计事件。材料中的 roleSha 取**本次派发角色**正文 sha（roleId→`config/roles/<roleId>.md`，无角色=`"none"`；席位 `systemPrompt` 仅 legacy 兜底）——同车道换帽必换键、必 first。

**delivery 续接的 native id 绑定与缺证据 fail-closed**：delivery+sessionReuse run 的 spawn 时刻 `session.created` 保持唯一进程身份（`proc_<pid>`——process_missing 恢复按唯一 `proc_<pid>` 解析子进程 PID，不变量不动）；运行期 wire 广告的 native provider id（kimi `session.resume_hint` / codex `thread.started`）由 runner 在终态分派前追加**独立**绑定事实 `run.provider_session_bound`（事件说明见 §3.2 指向的登记表/生成清单；不猜 id、不把 opaque UUID 当 native id、不写凭据）。共享读取器（`resolvePriorProviderSessionId` / `resolvePriorProviderSessionIdFromEvents`——spawn 权威与 `run_continue` 预检同一判定 SSOT）优先采信绑定事实并严格校验：runId 信封、唯一性、native 非空且非 `proc_` 占位、与原 spawn 身份（backend/backendSessionId）一致；坏/重复/冲突事实拒绝，绝不回落旧值遮蔽。无绑定事实时保持既有 native `session.created` 兼容读取；该值的**可用性**由 backend-owned 纯验证钩子（`backend.canResumeWithRecoveredSessionId`，经现有 backend 实例调用——无 factory 分发表、共享层不按 backend 名分支、非认证能力轴）判定：kimi/codex（运行时自产 id）对 `proc_<pid>` 占位 fail-closed（`RunManager.start` 固定拒绝、`run_continue` 返回既有 `no_provider_session`，均在 lineage claim/worktree/child transcript/spawn 之前）；claude-code 覆写恒 true（resume 编译 routing.opaqueUuid，从不消费取回 id——合法 opaque 路径不被全局 proc 前缀规则误伤）；非进程式 backend（ACP）无该钩子、原 native `session.created` 语义不退化。非 delivery 复用 run 的晚补 `session.created` 写侧保持兼容（读取侧 LAST-bound）。历史 Kimi/Codex proc-only 父 run 不可续接（不迁移旧数据）。

**能力驱动 fail-closed**：backend 若无法表达所配置的复用策略，detached runner 在 provider spawn 前失败（`backend.supportsSessionReuse !== true` 即抛错），绝不静默开新 provider 会话。初始 background transcript 可记录这次 startup failure；不得把它误报成已复用成功。

**有界审计**：仅落盘 `run.session_reuse {mode, turn}` 这一条路由事实。MCP 输出不返回 backendSessionId / Lead id / workspace path / prompt / argv / PID / provider payload；`registry_list` 如实投影配置的复用模式（nullable）；busy 时返回固定可执行文案（指向 active run / 等待 terminal / `run_status`/`run_wait`），不回显 runId 或 opaque uuid。

**routing-request truth**：`run_dispatch` 输出**额外**投影闭集 `providerSessionRouting: "not_used" | "first_turn_requested" | "resume_requested"`——这是**路由请求**真相（由 `dispatchRun` 内部已选定的 `routing.turn` 派生：普通派发/普通 delivery 的 `lead_workspace` 有意不复用→`not_used`；first→`first_turn_requested`；resume→`resume_requested`；`accepted:false` 恒 `not_used`），**不是** provider 会话成功/建立的证明。该字段只说"请求了什么路由"，**绝不**暴露 routing mode、opaque uuid、Lead id、workspace path、argv 或 provider payload；provider 是否真正 resume 成功仍由后续传输/终态证据决定。闭集由 `runDispatch.js` 的冻结 `PROVIDER_SESSION_ROUTING` SSOT 派生，MCP `z.enum` 直接引用，注入的越界值被拒绝并折叠为固定 dispatch error。`run_continue` 的 resume 路由语义不变。

**CLI 行为**：CLI 是一次性进程，无稳定 Lead 会话，因此 CLI 派发可复用专家时一律走 `first`（注入一次性 leadSession → 唯一复用 key、无历史 → 首轮）。MCP server 是唯一提供稳定 Lead 会话的调用方。

---

## 5. 多步编排

WAO 不提供 DAG 执行或"预先声明、由控制面推进"的多步计划（决定 0094 退役了原 workflow/DAG 层；读侧仍识别旧 `wf_*` 归档转录）。多步编排由 Lead 用现有原语组合完成：并行研究与核验用 consult（`run_consult`）；实现加验证用带交付规格的派发（`run_dispatch` + 交付验证、会审包、裁定）；续接与纠偏用 `run_continue` / `run_correct`。验收与语义决策始终归 Lead。量大且重复的流水线在宿主侧写脚本调用 WAO 的派发、等待与交付原语实现，不在控制面里再建第二套状态机；"A 跑完自动接 B"的无人值守串联由宿主定时唤醒 Lead 决定（不变量 4）。

---

## 6. 横切层

### 6.1 scorecard（证据链门控）

```js
export async function checkScorecard({ events, cwd, rules, inferCommandExitCode = false })
// → { passed, checks: [{ name, passed, evidence, detail? }] }
```

scorecard 不碰 backend，`requireFiles` 会查磁盘；**判定来自程序检查，不来自 LLM**。

- 检查项（检查名闭集 = `CHECK_NAME` 冻结、全仓唯一登记处：`hasDoneEvent`/`hasEvidence`/`hasAssistantText`/`acceptance`/`commandsPassed`/`filesExist`；发射未登记/重复名字在构造端抛错；run_status 与 MCP wire enum 同源派生）：`hasDoneEvent` 恒发（`run.completed` 在场）；`requireCommands`（命令出现且 exitCode=0，包含匹配；退出码缺失时是否从 tool_result 推断由 backend 的 `reportsCommandExitCode` 声明门控，默认不推断）；`requireFiles`（file_written 证据或磁盘存在，尾部路径匹配）；`requireEvidence`（至少一条证据事件；`--read-only` 零证据 run 豁免；`completed_empty` marker 只解释不翻案）；`requireAssistantText`（非空 assistant 文本）；`requireAcceptance`（Lead 提供的独立验收脚本，exit 0 = 通过，stderr 透传 detail）。
- **与状态机**：不通过且 `mode:"hard"` → 记 `run.error` 并 `running→failed`；`mode:"warn"` → 只记 `scorecard.warn` 留痕，不阻塞完成。每次检查落 `scorecard.checked`。
- **默认**：无显式 rules 时按 `scorecardMode`（默认 warn）——`warn`/`hard` → `{ requireEvidence:true, mode }`；`off` → null 不门控。优先级：显式 `options.scorecard` > `agent.scorecard` > 模式默认。CLI 开关 `--scorecard-mode hard|warn|off`，用法见 SKILL.md。

### 6.2 metrics

```js
aggregateRunMetrics(events, runId = null)   // 单 run：{ state, tokens, durationMs, costUsd? }
aggregateSummary(runs, runIds = null)        // 跨 run：{ totalRuns, byState, successRate, totalTokens, avgDurationMs }
```

报表读取按 runId 信封绑定收窄（`boundReportScope` 单一定义处）：带信封 transcript 只见本 run 事件；无信封 legacy transcript 保持历史读法；`--summary` 以文件名 stem 为权威 runId。duration = `run.started.ts` 到最后一条绑定事件；tokens/costUsd 取最后一条 `run.metrics`。

---

## 7. 目录结构与模块边界

> 本节目录树注释只承载**契约**（闭集、委托关系、安全边界），不承载实现史；在册债务见 `docs/tech-debt.md`，架构决策记录见 `.wao/decisions/`。

```
src/
├── cli.js                    # L4：CLI 入口与路由
├── registry.js               # L1：registry 加载
├── transcript.js             # L1：JSONL transcript
├── runManager.js             # L2：RunManager + 状态机
├── isolation.js              # L2：worktree（进程隔离=Node 内置 Job Object v22 + taskkill；端口表见 portAllocator.js）
├── delivery.js               # L2：Coder Delivery Contract v1（isolated delivery inspect/package，不 import CLI/RunManager）
├── portAllocator.js          # L2：端口分配表（未接入任何调用方——在册 tech-debt，见 docs/tech-debt.md）
├── metrics.js                # 横切：metrics 聚合
├── runEvent.js               # L1：RunEvent 类型（message/done/metrics + 证据 command/file_written/tool_use/tool_result）
├── scorecard.js              # 横切：证据链门控
├── diagnosis.js              # 横切：故障诊断（给证据不给处方）；类别闭集 = DIAGNOSIS_CATEGORIES（provider_auth/provider_capacity/config_conflict/timeout/budget/scorecard_fail/evidence_passed_backend_failed/provider_disconnect/no_effect/crash/aborted_manual/workdir_escape/delivery_packaging_failed/unknown/none）
│                              # code 闭集单一通用 SSOT：`DIAGNOSIS_CODES` = `PROVIDER_DIAGNOSIS_CODES` ∪ `PROVIDER_CAPACITY_DIAGNOSIS_CODES` ∪ `NO_EFFECT_DIAGNOSIS_CODES`（三组冻结码不互并，completed_empty 不并入 provider 集）；MCP run_diagnose/run_await_result 与内核真相共用同一 code 闭集，无第二份列表
│                              # provider_auth 专属：entitlement 拒绝归 provider_auth；码表 = `PROVIDER_DIAGNOSIS_CODES`（5 值），code 永不回显原文
│                              # provider_capacity：只有 failed 终态的持久 `run.error` 可归 `provider_capacity`（`rate_limited` / `quota_exhausted`），非终态 runtime rate-limit 活动不升级为失败；WAO 不据此自动重试或换 worker
│                              # provider_disconnect：worker 活跃工作后静默≥120s 且 exit≠0；或本运行最后一条 run.error 是 zcode / kimi-web 的静默收口文案（锚定前缀的门表；kimi-web 的 serve 不应答归 unknown）。zcode 文案带上游摘要、最后的主轮请求 failed 且状态码 429/401/403 时先归 provider_capacity / provider_auth；auth/config/capacity 先判，no_effect/crash 后判
│                              # completed-empty 真相：进程 exit 0 是传输完成，不等于 worker 产出了可用结果——completed run 若仅有 transport 活动（runtime init/thinking/zero-usage metrics）而无 assistant 文本/命令活动/文件写入/工具调用，归 no_effect + 内核码 completed_empty（NO_EFFECT_DIAGNOSIS_CODES）
│                              # 投影规则：经 `isValidDiagnosisCode(category, code)` 配对校验投影——provider_auth 携带 provider 码、provider_capacity 携带 rate_limited/quota_exhausted、no_effect 携带 completed_empty、其余类别恒为 null；failed no_effect 仍 null，正常 completed 仍 none/null；有效 tool-only/command-only/file-written run 仍判 none
├── smoke.js                  # L4：真实 CLI smoke 入口（npm run smoke）
├── mcp/                      # L4：MCP adapter（agent-facing primary）
│   ├── server.js             #   MCP server factory + 23 tools（registry_list/workspace_status/workspace_select/lead_preflight/run_dispatch/run_dispatch_contract_check/run_consult/run_continue/run_correct/run_status/run_collect/run_diagnose/run_delivery/run_delivery_decide/run_stop/runs_list/run_wait/run_await_result/run_activity/run_delivery_review/run_delivery_review_bundle/run_delivery_repackage/run_delivery_reverify；playbook catalog 为 wao://playbooks resources 非 tools；roster 名序=toolSurface SSOT）
│   ├── toolSurface.js        #   冻结工具面 SSOT：23 个 always-registered tools 的 frozen 数组（playbook 目录不在工具面，由 MCP resources 承载）+ 唯一性/计数不变量；server.js 构造期 deepEqual 自检，无 Host/runtime 分支、无 profile
│   └── stdio.js              #   stdio production entrypoint（StdioServerTransport，npm run mcp，--workspace-root；未知 flag 一律忽略不失败，含旧 profile 参数）
├── application/              # L4：shared application services（use-case 层）
│   ├── registryInventory.js  #   registry inventory SSOT（CLI + MCP 共用；providerReadiness 严格真相投影——CONFIGURATION_STATUSES/AUTHENTICATION_STATUSES/ENTITLEMENT_STATUSES/LIVE_CHECK_STATUSES 闭集常量，MCP 枚举直接派生，无第二份列表；独立部分投影 getRegistryInventoryWithIssues + REGISTRY_ISSUE_CODES/REGISTRY_ISSUES_CAP 闭集——registry 可读但单条坏条目时返回有效 worker + 有界安全 issues 而非整表失败，严格路径不变）
│   ├── runDispatch.js        #   background dispatch service（CLI + MCP 共用；continuable 选项——delivery-only 续谱根，建立 run_lineage turn:first provider 会话；MCP adapter 派发前经共享 executionProfiles resolver 解析可选 executionProfileId（profile/inline 互斥），把解析后的 verification 折入 effective delivery 传入；runDispatch.js 自身不解析 profile；providerSessionRouting 闭集输出——仅由内部已选 routing.turn 派生的路由请求真相，非 provider 成功证明，不暴露 mode/opaque uuid）
│   ├── runDispatchContract.js #   advisory pre-dispatch contract check service（MCP）：MCP adapter 在 run_dispatch 与本工具间共享输入 schema（service 自身不导入 Zod），service 复用同一 application 校验（共享 resolver + prepareDeliveryRequest），返回闭集 workspace/registry/contract 视图 + 有界 issue 码；contractValid 只反映 delivery/profile 机械合同（不预评 expectedGitHead/expectedDirty/expectedWorkspaceRoot、continuable/backend/session 资格或凭据），非门禁（sections 独立 observed/unknown、advisory 恒 true）、零副作用、run_dispatch 不可依赖它
│   ├── executionProfiles.js   #   frozen trusted execution-profile catalog + 共享 delivery 验证解析器：node-npm-test-v1 / node-npm-ci-test-v1 / python-pytest-v1 仅提供 verificationSetup/verificationCommands；profile 与 inline verification 互斥，未知/冲突由共享 resolver 稳定拒绝
│   ├── runContinue.js        #   Lead 授权修正续跑 service（由 MCP adapter 直接委托）：对终态 continuable delivery 续 ONE 修正回合，复用父 run 的 retained worktree + 续 provider 会话（turn:resume，同一 opaque uuid）；closed-set 资格/身份/配置/worktree 检查先于 mutation，spawn 前失败事务回滚；共享读取器 + backend 钩子的完整可续接预检先于 claim/worktree/child transcript/spawn，缺真实 provider 会话证据返回既有 no_provider_session；从不推断 correction/scope/retry/accept
│   ├── runStatus.js          #   read-only run status service（CLI + MCP 共用）
│   ├── runCollect.js         #   run collection service（CLI + MCP 共用）
│   ├── runDiagnosis.js       #   read-only run diagnosis service（CLI + MCP 共用）
│   ├── runDelivery.js        #   delivery query + decision service（CLI + MCP 共用）
│   ├── runStop.js            #   runaway worker stop service（CLI + MCP 共用，workspace-bound）
│   ├── runList.js            #   workspace-bound run list service（查询内复用 ownership proof）
│   ├── runWorkspaceOwnership.js # run workspace ownership判定（query-scoped proof cache；前台收口：background 权威 = 恰好一条绑定的 `run.background_submitted` 事件 + 其 `cwd` 字段——**不是** payload 的 `background:true` 布尔；foreground = 无 background_submitted 且恰好一条绑定 `run.started` 且 cwd 有效；envelope runId 精确绑定，legacy 无 runId 容错仅在没有任何 ownership 事件携带 runId 时启用；`proveWorkspace` realpath + Windows 平台大小写折叠）
│   ├── runWait.js            #   long-poll 终态/活性等待 service（MCP 共用，只读）
│   ├── runAwaitResult.js     #   read-only composite：bounded wait + observation + terminal compact（snapshot-only，advisory；readFailureReason 闭集；终态+快照干净时投影有界闭集 outcome——diagnosis+delivery 安全事实，无 commit/path/diff/命令/推荐，复用同一 snapshot、零额外读）
│   ├── ownerLiveness.js      #   run liveness 投影 SSOT（terminal/progress/process_only/silent，runWait/runAwaitResult 共用）
│   ├── workspaceBinding.js   #   host-authorized workspace proof SSOT（MCP 共用）
│   ├── sessionWorkspace.js   #   Lead session workspace selection kernel（无状态，委托 proveWorkspace）
│   ├── sessionReuse.js       #   expert session reuse SSOT（provider 中立：opaque uuid 派生 + turn 决策 first/resume/busy + per-key 文件锁；run_lineage routing——续谱作用域 = Lead session + workspace + agent + rootRunId，复用同一 opaque provider id；run_lineage 是 routing-only，不是 agent 可声明策略；前任会话读取器优先校验 run.provider_session_bound 绑定事实，坏事实 fail-closed 不回落）（CORE_MEMBERS 例外：归 core 桶）
│   ├── leadPreflight.js      #   advisory single-call preflight aggregator（组合 registryInventory+listRuns，advisory 非 gate；registryIssues/registryIssuesTruncated——复用 registry_list 同一闭集 issue 形状与同一单读快照，非空时 checkStatus.workers=warning→complete:false 但有效 worker 照常返回）
│   ├── mcpWorkspaceActivation.js # project-scoped workspace activation（CLI 用，委托 hostAdapters）
│   ├── timeoutPolicy.js      #   wait timeout precedence SSOT（CLI + MCP 共用）
│   ├── processStopVerify.js  #   bounded process exit verification
│   ├── runDeliveryReview.js  #   exact delivery proof + bounded/redacted diff review（CLI + MCP 共用）
│   ├── playbookCatalog.js    #   read-only Lead Playbook Catalog SSOT（loader + MCP/CLI 共用；validatePlaybookSummaryList/validatePlaybookV1）
│   └── runSemanticsNotes.js  #   pure provider-neutral semanticNotes SSOT（冻结静态目录 + 纯 selector；四 tool 成功结果的 1..4 条 self-describing notes）
├── hostAdapters/             # L4：host-specific config adapters
│   └── codexMcpConfig.js     #   Codex CLI MCP server CRUD（add/get/remove/list，不写 TOML）
├── backends/
│   ├── opencodeServe.js      # L1：HTTP 类 backend
│   ├── processBackend.js     # L1：进程式 backend 基类
│   ├── claudeCode.js         # L1：claude-code 后端（`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 注入【每一个】supervised 子进程 env——native OAuth / provider wrapper / start / resume 会话复用；backend 安全值压过 agent.env 反设，含 Windows 大小写不敏感的变体；阻止/抑制 provider auto-memory 写入；仅 claude-code 接收该变量，其它 backend 不注入。native OAuth 通道凭据双模式：`CLAUDE_CODE_OAUTH_TOKEN` 长期令牌可解析时隔离目录保持空、不拷贝 `~/.claude` 凭据、认证走 env（名字经 envPolicy native 通道继承并进脱敏器）——凭据拷贝与续期令牌单次轮换互斥；令牌缺席回退 spawn 时现拷贝路径）
│   ├── codex.js              # L1：codex 后端
│   ├── deepSeekHarness.js    # L1：实验性 DSH stdio JSON-RPC 后端
│   ├── deepSeekAcp.js        # L1：DSH ACP 集成面后端（dsh --profile acp + --patch containment/role-contract；契约见 §2.5b）
│   └── parsers/
│       ├── lineStream.js     # stdout 行流解析基类
│       ├── claudeCode.js     # claude-code stream-json 解析
│       └── codex.js          # codex 输出解析
config/
├── agents.example.json       # registry 模板（每车道一条）
└── default.json              # 默认设置
test/
└── （各模块配 node:test 测试）
```

> **不存在的模块**（勿当作既有文件）：`scheduler.js`（限并发调度器，未实现，见 §4.4；在册 tech-debt：docs/tech-debt.md）。原 `src/workflow/`（DAG 引擎）已随决定 0094 删除。

**Lead Playbook Catalog（只读、不执行）**：`playbooks/lead/*.json` + `application/playbookCatalog.js` + MCP resources `wao://playbooks`/`wao://playbooks/{id}`（只读 resources/CLI）。Catalog 是可选的 Lead 决策脚手架：evidence gate、adaptation point；Lead 保留/跳过/修改条件步骤。它是只读数据 + application service（`validatePlaybookSummaryList`/`validatePlaybookV1` 作为 loader 与 MCP/CLI adapter 共用的 SSOT），不派发、不执行、不推进 phase、不验收——不存在 `playbook_run`/`playbook_start`/`playbook_next`/`playbook_recommend`。多步执行能力（DAG 引擎）已随决定 0094 退役，见 §5。

**模块边界规则**：
- backend 特定逻辑**只在** `src/backends/` 下
- 状态机逻辑**只在** `runManager.js`
- 隔离机制**只在** `isolation.js`
- CLI 只做路由 + 调用 RunManager，不持有业务逻辑

---

## 8. 配置

默认值来自 `src/cli.js` 的 hardcoded defaults；`config/default.json` 中的同名键覆盖默认值。生效键集与默认值：

```jsonc
{
  "registry": "config/agents.json",
  "runDir": "runs",
  "stateDir": ".wao",
  "pollInterval": 5000,
  "waitTimeout": null,            // 派发侧等待窗：null=禁用；到期只通知不终止（观察预算，非执行死线），为什么见决定 0030
  "timeout": 30000,               // 单次后端请求超时（ms）
  "defaultIsolation": "none",     // "none" | "worktree"
  "worktreeDir": null,            // daemon 统计 worktree 残留的目录；null = ".wao-worktrees"（worktree 固定建在 <repo>/.wao-worktrees/）
  "silentTimeout": null,          // 静默无响应早失败：null=不启用，数值=ms
  "debugMode": false              // friction log 调试开关：config 显式值优先于 WAO_DEBUG=1 env
}
```

优先级链：CLI flag 覆盖 config，config 覆盖 hardcoded defaults。
隔离解析优先级：`--isolate` flag > `agent.isolation` > `defaultIsolation`；strategy（`persistent`/`ephemeral`）只能在 agent 配置对象里设置，flag 与 config 路径恒为 `persistent`。
