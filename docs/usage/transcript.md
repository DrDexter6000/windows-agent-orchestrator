# transcript 格式

> [使用手册](../usage.md)的一页：transcript 放在哪、记哪些事件、怎么把平铺的旧 transcript 迁进项目桶。

> 下表投影自 `docs/02-architecture.md` §3.2，是同一份事件清单的人读视图；architecture 是真值源。`test/isolation-infra/docs-consistency.test.js` 的守卫保证两表事件名集合相等。其它文档（SKILL.md 等）只指向本投影或 spec，不维护第三份清单。

每个 run 的事件流存在该 run 的转录文件里，每行一个 JSON 事件。新 run 写 `runs/projects/<slug>/<runId>.jsonl`；旧平铺 `runs/<runId>.jsonl` 只读兼容，长期共存。定位转录一律经 `src/projectBuckets.js` 的解析链，不要自己拼路径。

完整事件类型：

| 事件 | 含义 |
|------|------|
| `run.started` | run 创建，记录生效的 backend/cwd/model/worktreePath。带 `--model` 覆盖的派发另含显式 `modelOverride` 字段，`model` 为合成后策略——只替换 `.id`，兄弟字段保留；`reasoning` 无条件落盘（agent 无 reasoning 时 JSON 省略该键），带 `--reasoning` 覆盖的派发另含显式 `reasoningOverride` 字段，合成后同样只替换 `.effort`；`providerKey` 无条件落盘，是 provider 接入方指纹（归一化 baseUrl + `apiKeyEnv` 变量名；userinfo/query/fragment 在归一化时丢弃，凭据不入 transcript），无 provider 块的 lane 为显式 `null`（已观察无接入方，与 legacy 父 run 的字段缺失区分），也是 `run_continue` 续跑漂移比对的父侧 durable 事实 |
| `run.state_change` | 状态转移（from/to/reason） |
| `run.state_change_rejected` | first-terminal-wins 拒绝迟到的状态转移，记录 attemptedTo/attemptedReason/existingTerminal |
| `session.created` | backend session 建立 |
| `run.provider_session_bound` | delivery+sessionReuse run 在终态分派前，把 wire 上观察到的 runtime native provider id（如 kimi `session.resume_hint`、codex `thread.started`）与原 spawn 身份（`backend`+`backendSessionId`，进程式为 `proc_<pid>`）关联记录的独立有界事实；后续 `run_continue`/复用读取器优先采信它取回真实 provider 会话 id，坏/重复/冲突事实一律拒绝，不回落占位值 |
| `prompt.sent` | prompt 投递（含完整 prompt 文本） |
| `run.submitted` | 投递完成，进入等待 |
| `run.metrics` | token 用量 + 成本（旁路，不触发状态转移） |
| `run.event` | RunEvent 透传（含 command、write_intent、file_written、tool_use、tool_result；write_intent 仅是未确认的 containment telemetry） |
| `scorecard.checked` | scorecard 门控结果（passed + checks），仅配了 rules 时写 |
| `run.completed` | 正常完成 |
| `run.timed_out` | legacy：只出现在旧转录。现在等待窗到期不写此事件，改写 `run.observation_deadline_reached`（通知不杀）。保留它仅为读取 legacy 转录（findState/诊断兼容面）。为什么见决定 0030 |
| `run.aborted` | 被 abort |
| `run.error` | 错误 |
| `run.stop_requested` | 用户请求停止 |
| `run.wait_policy` | 实际生效的等待超时策略（waitTimeoutMs + source: explicit/agent/global/disabled）。默认 disabled（waitTimeoutMs 为 null） |
| `run.observation_deadline_reached` | 等待窗到期的观察事实，载荷恰为 `{waitTimeoutMs, source}`（有界，不回显路径/环境）。到期不终止 worker（通知不杀）：前台 CLI 打印一行指引后继续等，后台 runner 继续监督到自然终态。每 run 至多一条 |
| `run.stop_verified` | worker runtime 已确认静默；可能来自普通终态清理或显式 `run_stop`，不表示 Lead 一定调用过 stop |
| `run.stop_unverified` | worker runtime 未能确认静默（outcome: alive/probe_error）；可能来自终态清理或显式 stop |
| `messages.collected` | collect 命令拉取消息 |
| `acceptance.recorded` | Lead 侧验收落盘（`wao accept` CLI），载荷 {decision(accepted/rejected), reason, evidenceDigest?, evidenceSummary?, recordedBy:"lead", recordedAt, source}。只对终态 run 追加；多笔合法（审计日志语义，最新一笔为当前结论）；不覆盖 delivery run 的 `run_delivery_decide` 语义（那是恰一笔 first-wins 决定面）——本事件是非 delivery run 的验收承载 |
| `run.rerun` | 进程式 resume 重放（originalSessionId → newSessionId） |
| `run.cleanup_done` | 终态清理完成（worktree 删除 + backend 文件工件 dispose；非 delivery run 也会发） |
| `run.delivery_created` | delivery 打包成功，含完整 DeliveryRef |
| `run.delivery_failed` | delivery 打包失败，含 deliveryCode + message |
| `run.delivery_verification_passed` | delivery 验证通过 |
| `run.delivery_verification_failed` | delivery 验证失败，含 failureCode。事件内 DeliveryRef 的 `verification.results`（与 `setupResults`）每个命令结果带 `stdoutTail`/`stderrTail` 字段：仅非成功结果（非零退出/超时/launch error）携带内容，各保留尾部 ≤8192 字节原始输出加截断标记 `…[truncated N bytes]`（N 为丢弃字节数）；成功结果恒为空串（绿输出只计数不落体）。内容是仓内生成的子进程测试输出，随整包走 transcript append 的 exact-secret 脱敏（字面凭据值改写为 `[REDACTED:NAME]`）；MCP `run_delivery` 的 `verificationFailureSummary` 只含纯标量键，不带尾内容，要看尾内容就读 transcript（形状见[交付与验收](delivery.md)） |
| `run.delivery_verification_unavailable` | 无验证命令（unavailableReason） |
| `run.delivery_accepted` | Lead 接受，含 updated DeliveryRef + deliveryCommit + reason |
| `run.delivery_rejected` | Lead 拒绝，含 updated DeliveryRef + deliveryCommit + reason |
| `run.delivery_repackage_rejected` | `run_delivery_repackage` 的 expected-policy 拒绝审计，payload 仅闭集 `rejectionReason`（无路径/凭据/计数），每次被拒尝试恰一条；`malformed_input`/`run_not_found`/`workspace_not_authorized`（跨项目不写）不落 |
| `run.read_only_declared` | 只读声明（`run_dispatch` 顶层 `readOnly:true` / CLI `run --read-only`），start 时恰一次的 durable 事实。payload 为空（envelope 即事实，无 prompt/路径/argv）；它的存在是 `run_activity` 附带 `readOnlyObservation` 观察投影的权威输入，本身不构成任何门 |
| `run.lead_commit_check_started` | `runs verify-commit` 首命令前写入：checkId 随机 nonce、受检提交全形、命令清单原文 + commands-file 字节 sha256、timeoutMs、终态判定依据（准入只认终态 run.state_change；legacy 推断终态无准入资格，追加自检事件会翻转其推断状态）、提交关系事实字段（isDeliveryCommit/containsDeliveryCommit/adoptedFromTrailer，记事实不设拒）；`kind:"lead_self_check"` + `independentAuditRequired:true` 边界锁。仅有 started 无 outcome 是合法的不完整证据，绝不读作通过 |
| `run.lead_commit_check_outcome` | `runs verify-commit` 收口：status∈{passed,failed,aborted}、results[]（index/exitCode/timedOut/durationMs + 失败 8KiB 尾）、独立 cleanup∈{ok,failed} 字段。不做恰一条 CAS（允许多次核验，checkId 区分）；本事件族不进 validateDeliveryFacts/decide/wao accept 的任何判定输入 |
| `workflow.*` | DAG 节点级事件（workflow.started/completed、node.started/completed），写独立 `wf_*.jsonl` |

`run.message` 不是落盘事件类型：RunManager 把 message 的 role/parts 传给 scorecard 供 `requireAssistantText` 检查，不写进 transcript。

状态机的完整定义见 `docs/02-architecture.md` §4.1，本文不复制状态列表。

交付类 run 的终态语义：

- delivery 打包失败的 run 终态是 `failed`（reason=`delivery_failed`），不是 completed。所以"completed 计数为 0"不等于 worker 什么都没干。
- 反过来 completed 也不保证交付成功：打包成功即转 completed，验证在其后执行且不回改终态；成败要看结果里的 deliveryRef 与 verification 结果。
- 区分"worker 是否产出过模型工作"看 completionMarker：`run.completed` / `run.delivery_failed` / `run.error`(phase=delivery) 可携带 `completionMarker: "completed_empty"`（闭集 DONE_MARKERS 成员），表示 worker 零产出。
- 空 diff 打包失败（`empty_diff`）另有一种相反情形：worker 按交付合同停手并上报了 `SCOPE_EXPANSION_REQUIRED`。此时 `run.delivery_failed` / `run.error`(phase=delivery) 携带 `workerDeclared: "scope_expansion_required"`，`runs diagnose` / `run_diagnose` 的 evidence 多一条 "worker stopped on purpose…" 事实；路径与理由在 worker 的最终回复里（`collect <runId> --final`），失败码仍是 `empty_diff`，不为它新增码值。
- 排查入口：MCP `run_diagnose` / `run_await_result`（CLI 对应 `runs diagnose` / `runs wait`；category=no_effect ↔ code=completed_empty）。交付类 + completed_empty 的失败出口（scorecard 门拦下或打包失败）还会向 `runs/ALERTS.log` 写 level=no_effect 告警，每 run 至多一次。

## 直接读 transcript

```powershell
npm run cli -- tail <runId> --limit 50
# 或直接读文件（路径由 wao 解析链定位，见 docs/02-architecture.md §3）
Get-Content <转录路径> | ForEach-Object { $_ | ConvertFrom-Json }
```

## 存量平铺转录迁移（runs migrate-projects）

把旧平铺 `runs/<runId>.jsonl` 实迁进项目桶。三个形态：

- 默认 dry-run：只读预览桶分布、字节数、无法归因原因分布；`--run-dir` 生效。
- `--apply`：实迁。
- `--verify`：迁移后只读核对。

`--apply` 的行为：

- 归宿判定走写侧权威 `resolveRunDirForWrite`，冻结桶、.project.json、索引全部复用。
- 移动原语是同卷 `link`（EEXIST 原子拒，防 Windows rename 静默覆盖）→ dst sha256 核对 → unlink 源。
- 台账落在 `.wao/migration/td190-d3/apply-<ts>.jsonl`，intent/result 双行，幂等可续跑。
- 门：active run 为空、拒绝在 worktree 内执行、操作员确保无并发 WAO 写操作。
- 非终态转录一律不动（fail-closed）；无法归因的存量迁入 `_unattributed` 桶。

`--verify` 核对 dst 在场、sha 漂移、根层剩余，并点名根层再现——并发追加者持旧路径会在迁移后复活平铺文件；按点名手工合并后再重跑。

回滚边界：没有自动回滚工具。反向移动须人工按 manifest 台账核对，仅当台账 sha 是当前内容前缀时才可反向；迁移后的合法追加不盲搬。

迁移门与回滚边界的由来，为什么见决定 0060。
