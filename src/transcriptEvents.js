// src/transcriptEvents.js
//
// Transcript 事件类型登记表——事件名与说明的唯一可编辑真值源。
//
// 分工：事件名与说明只在本登记表编辑；人读清单由生成层产出
// （scripts/gen-surface.mjs → docs/surface/transcript-events.md）；
// 写入侧守卫（src/transcript.js 所有写出口共用的序列化入口）保证代码
// 写出的每种事件都已登记；docs/02-architecture.md §3.2 与
// docs/usage/transcript.md 只指向生成清单，不维护表格。
//
// 边界：
//   - `run.message` 不是落盘事件类型（RunManager 把 message 快照传给
//     scorecard，不写进 transcript），因此【不】登记——它不是漏登。
//   - `run.timed_out` 标 legacy：没有现行生产写出点，仅为读取旧转录保留
//     （findState/诊断兼容面）。
//   - workflow 事件登记四个具体名字（不登记通配），写独立 `wf_*.jsonl`。
//   - 本模块零相对出边（node only）；消费方 src/transcript.js（写入侧
//     序列化守卫）、scripts/gen-surface.mjs（渲染生成清单）与测试。
//
// 严格模式（WAO_TRANSCRIPT_EVENT_STRICT=1，测试基建显式设置；生产默认关）：
//   - 写出未登记类型立即抛错（见 transcript.js 的共用序列化函数）；
//   - 违规同时记入本进程清单，退出钩子在进程退出时把清单打到 stderr 并
//     置非零退出码——有几处写出会吞掉异常（观察截止的追加、上游会话
//     释放），靠这一步被测试抓红；
//   - 未开启时绝不丢弃、拒绝或推迟任何一条事件：最多往 stderr 打一次
//     警告（每种类型一次），照常写盘。

/**
 * 登记表。每条：具体事件类型名 + 说明（何时写、载荷约束、闭集指针、
 * 兼容说明；架构表与手册表两边事实的并集）+ 可选 legacy 标记。
 * 顺序即生成清单的行序（生命周期 → 终态事实 → 会话/消息 → 交付 →
 * 复核 → 纠错 → 回收/线系 → scorecard → workflow 族）。
 */
export const TRANSCRIPT_EVENT_REGISTRY = Object.freeze([
  {
    type: "run.started",
    description: "run 创建；记录生效 backend/cwd/model/worktreePath 与显式 override、agentArgs 摘要（count+sha256 指纹+addDirs 暴露面路径；无 args 缺席）。带 `--model` 覆盖的派发另含显式 `modelOverride` 字段，`model` 为合成后策略——只替换 `.id`，兄弟字段保留；`reasoning` 无条件落盘（agent 无 reasoning 时 JSON 省略该键），带 `--reasoning` 覆盖的派发另含显式 `reasoningOverride` 字段，合成后同样只替换 `.effort`；`providerKey` 无条件落盘，是 provider 接入方指纹（归一化 baseUrl + `apiKeyEnv` 变量名；userinfo/query/fragment 在归一化时丢弃，凭据不入 transcript），无 provider 块的 lane 为显式 `null`（已观察无接入方，与 legacy 父 run 的字段缺失区分），也是 `run_continue` 续跑漂移比对的父侧 durable 事实；delivery 派发另含 delivery 块（allowedPaths 等交付合同事实）。",
  },
  {
    type: "run.state_change",
    description: "状态机转移（from/to/reason）；`reason` ∈ `STATE_CHANGE_REASONS`（闭集 SSOT = `src/transcript.js`）。",
  },
  {
    type: "run.state_change_rejected",
    description: "first-terminal-wins 拒绝迟到的状态转移，记录 attemptedTo/attemptedReason/existingTerminal；证明后新事件守卫拒绝时 reason 为 `observed_seq_changed`（附期望/实读 last seq）。",
  },
  {
    type: "run.background_submitted",
    description: "后台派发的首条 durable 事实（runDispatch/runContinue 在派发器进程写，先于 detached runner 启动）：background:true、解析后的绝对所有权 cwd（相对 cwd 不可证明工作区身份；runDispatch 的交付所有权记录 run.background_submitted.cwd 即取自它）、scorecardConfigured、deliveryRequested、可选 correctable:true（run_correct 的稳定门事实）、可选 mcpParentImage（MCP 父进程镜像名溯源）、D2-②b 首事件落档的桶归属事实；runContinue 续跑写时另含 continuation: true、parentRunId 与线系根标识 rootRunId。",
  },
  {
    type: "run.session_reuse",
    description: "会话复用 run 的有界路由审计事实：载荷恰 {mode, turn}（run_lineage 模式另携 rootRunId——仅 WAO runId，供后续 run_continue 从任意父转录解析线系键）；绝不携带 opaque uuid、Lead id、workspace、prompt、argv 或 provider payload；非复用 run 零写出（零漂移）。",
  },
  {
    type: "session.created",
    description: "backend 建立 provider session（进程式为唯一身份 `proc_<pid>`——process_missing 恢复按它解析子进程 PID）。",
  },
  {
    type: "run.provider_session_bound",
    description: "delivery+sessionReuse run 在终态分派前，把 wire 上观察到的 runtime native provider id（kimi `session.resume_hint`、codex `thread.started`）与原 spawn 身份（`backend`+`backendSessionId`，进程式为 `proc_<pid>`）关联记录的独立有界绑定事实——不补第二条 `session.created`（process_missing 恢复依赖唯一 `proc_<pid>` 身份）；共享续接读取器（`resolvePriorProviderSessionId`/`resolvePriorProviderSessionIdFromEvents`）优先采信并严格校验（runId 信封、唯一性、native 非空且非 `proc_` 占位、与原 spawn 身份一致），坏/重复/冲突事实 fail-closed 拒绝、绝不回落旧 `session.created` 值遮蔽。",
  },
  {
    type: "prompt.sent",
    description: "prompt 投递（含完整 prompt 文本，append 前脱敏）。",
  },
  {
    type: "run.submitted",
    description: "投递完成，进入等待。",
  },
  {
    type: "run.metrics",
    description: "token 用量、成本与耗时事实；旁路，不触发状态转移。",
  },
  {
    type: "run.event",
    description: "RunEvent 透传（message/command/tool/write telemetry 等；含 write_intent、file_written、tool_use、tool_result——write_intent 仅是未确认的 containment telemetry）。",
  },
  {
    type: "run.wait_policy",
    description: "实际生效的等待超时策略（waitTimeoutMs + source: explicit/agent/global/disabled）。默认 disabled（waitTimeoutMs 为 null）。",
  },
  {
    type: "run.observation_deadline_reached",
    description: "等待窗到期的观察事实，载荷恰为 {waitTimeoutMs, source}（有界，不回显路径/环境）。到期不终止 worker（通知不杀）：前台 CLI 打印一行指引后继续等，后台 runner 继续监督到自然终态。每 run 至多一条（多等待者按 run 级标志幂等去重）。advisory 事实：落盘失败被吞，不改变监督语义。",
  },
  {
    type: "run.stop_requested",
    description: "用户请求停止；含 reason:\"user\" 与 Lead 的理由、观察位置事实；不在 claim 前单独 append，经 transitionState 的 attemptEvents 同批提交。",
  },
  {
    type: "run.stop_verified",
    description: "worker runtime 已确认静默；可能来自普通终态清理或显式 `run_stop`，不表示 Lead 一定调用过 stop。载荷含 outcome/taskkillCalled/taskkillExitCode/processAliveBefore/processAliveAfter（进程路径）或 backend/method/taskkillCalled（opencode 路径），可重建\"为何 verified\"——以后置 PID 存活检查为准，taskkill exitCode=0 单独不构成 verified。",
  },
  {
    type: "run.stop_unverified",
    description: "worker runtime 未能确认静默（outcome: alive/probe_error）；可能来自终态清理或显式 stop；附 raiseAlert。",
  },
  {
    type: "run.completed",
    description: "正常完成（终态 fact，与 state_change 同批原子落盘）；可携 completionMarker:\"completed_empty\"（闭集 DONE_MARKERS 成员）表示 worker 零产出。",
  },
  {
    type: "run.aborted",
    description: "run 被 abort（终态 fact；verification:\"pending\" 起，winner 执行 kill/abort 后补 stop_verified/stop_unverified）。",
  },
  {
    type: "run.error",
    description: "run 错误（非终态旁路事实；终态由 state_change 承载）。phase 标注来源（spawn/wait/scorecard/delivery 等）；delivery 失败时与 run.delivery_failed 同批另写，可携 completionMarker:\"completed_empty\"、workerDeclared:\"scope_expansion_required\" 或 errorClass（打包环境类别闭集，含义见 run.delivery_failed 行；分类不出时键缺席）。",
  },
  {
    type: "run.timed_out",
    description: "legacy：只出现在旧转录。现在等待窗到期不写此事件，改写 `run.observation_deadline_reached`（通知不杀）；状态值保留在类型与 TERMINAL_STATES 中仅为读取 legacy 转录（findState/诊断/投影不得回归）。为什么见决定 0030。",
    legacy: true,
  },
  {
    type: "run.budget_exceeded",
    description: "token 预算硬闸触发事实（budget/used/multiplier/backendSessionId）：超限即转 failed（reason=budget_exceeded）并兜底 abort；同时 raiseAlert（告警失败不阻塞终态）。",
  },
  {
    type: "run.isolation_failed",
    description: "非交付、非只读 run 的 worktree 隔离创建失败事实（{error} 有界摘要）：写后降级用原 cwd 继续（交付与只读形态 fail-closed 拒绝派发，不写本事件）。",
  },
  {
    type: "run.isolation_violation",
    description: "写越界硬安全线（workdir escape）事实：安全 run-bound 载荷（如 code:\"workdir_escape\"），触发转 failed（reason=workdir_escape）；同时是恢复分类的冲突事实（存在即不可按 backend_failed/process_missing 恢复）。",
  },
  {
    type: "run.evidence_audit",
    description: "backend 失败但证据审计通过（passed:true + note + checks，检查名闭集见 runManager 构造端 SSOT）：\"证据其实通过了，任务可能做对了，需人工确认\"——终态仍 failed（不撒谎），诊断归 Lead，不自动改终态。",
  },
  {
    type: "scorecard.checked",
    description: "scorecard 门控结果（passed + checks），仅配了 rules 时写。",
  },
  {
    type: "scorecard.warn",
    description: "scorecard 默认 warn 模式不通过（{detail, checks}）：只记 warn 不转 failed，仍走 completed；`--scorecard-mode hard` 升级硬闸（改写 run.error + 转 failed），off 关闭。",
  },
  {
    type: "messages.collected",
    description: "collect 命令拉取消息（runCollect 经注入的 _append 写恰一条审计事件；载荷为有界消息投影）。",
  },
  {
    type: "acceptance.recorded",
    description: "Lead 侧验收落盘（`wao accept` CLI），载荷 {decision(accepted/rejected), reason, evidenceDigest?, evidenceSummary?, recordedBy:\"lead\", recordedAt, source}。只对终态 run 追加；多笔合法（审计日志语义，最新一笔为当前结论）；不覆盖 delivery run 的 `run_delivery_decide` 语义（那是恰一笔 first-wins 决定面）——本事件是非 delivery run 的验收承载。",
  },
  {
    type: "run.rerun",
    description: "进程式 resume 重放（originalSessionId → newSessionId）。",
  },
  {
    type: "run.read_only_declared",
    description: "只读声明（`run_dispatch` 顶层 `readOnly:true` / CLI `run --read-only`），start 时恰一次的 durable 事实。payload 为空（envelope 即事实，无 prompt/路径/argv）；它的存在是 `run_activity` 附带 `readOnlyObservation` 观察投影的权威输入，本身不构成任何门。",
  },
  {
    type: "run.cleanup_done",
    description: "终态清理完成（worktree 删除 + backend 文件工件 dispose；非 delivery run 也会发）。",
  },
  {
    type: "run.cleanup_error",
    description: "清理自身失败：只记账不抛错，不改变既定终态事实。两个写出点——派发失败后的清理写 {phase: \"spawn_fail\", error}；终态清理 _runCleanup 写 {error}，没有 phase。",
  },
  {
    type: "run.delivery_created",
    description: "delivery 打包成功，含完整 DeliveryRef。前台路径经 RunManager 终态批次的 attemptEvents（无论转移 accepted/rejected 都落盘，消除孤儿 delivery commit 窗口）；重打包路径与 run.delivery_repackaged 同批原子落盘。",
  },
  {
    type: "run.delivery_failed",
    description: "delivery 打包失败，含 deliveryCode + 脱敏摘要。completionMarker:\"completed_empty\"（闭集 DONE_MARKERS 成员）表示 worker 零产出；空 diff 且 worker 按交付合同上报越界停手时另携 workerDeclared:\"scope_expansion_required\"（闭集标记，不带路径/理由自由文本——路径与理由在 worker 最终回复里）；由错误对象结构化属性（status/code/syscall/signal，不读消息原文）分得出的打包环境类别另携 errorClass（闭集 git_index_locked/file_locked/permission_denied/disk_full/git_spawn_failed/git_timeout/git_command_failed，SSOT=src/deliveryErrorClass.js；分不出时键缺席，absent 非 null）。",
  },
  {
    type: "run.delivery_verification_passed",
    description: "delivery 验证通过（载荷为携带验证结果的 DeliveryRef）。",
  },
  {
    type: "run.delivery_verification_failed",
    description: "delivery 验证失败，含 failureCode。事件内 DeliveryRef 的 `verification.results`（与 `setupResults`）每个命令结果带 `stdoutTail`/`stderrTail` 字段：仅非成功结果（非零退出/超时/launch error）携带内容，各保留尾部 ≤8192 字节原始输出加截断标记 `…[truncated N bytes]`（N 为丢弃字节数）；成功结果恒为空串（绿输出只计数不落体）。内容是仓内生成的子进程测试输出，随整包走 transcript append 的 exact-secret 脱敏（字面凭据值改写为 `[REDACTED:NAME]`）；MCP `run_delivery` 的 `verificationFailureSummary` 只含纯标量键，不带尾内容，要看尾内容就读 transcript。",
  },
  {
    type: "run.delivery_verification_unavailable",
    description: "无验证命令（unavailableReason）。",
  },
  {
    type: "run.delivery_accepted",
    description: "Lead 接受 delivery（first-decision-wins CAS 恰一条），含 updated DeliveryRef + deliveryCommit + reason。",
  },
  {
    type: "run.delivery_rejected",
    description: "Lead 拒绝 delivery（first-decision-wins CAS 恰一条），含 updated DeliveryRef + deliveryCommit + reason；验证 pending 的有界拒绝也走本事件（快照显式保 pending）。",
  },
  {
    type: "run.delivery_repackage_rejected",
    description: "`run_delivery_repackage` 的 expected-policy 拒绝审计，payload 仅闭集 `rejectionReason`（无路径/凭据/计数），每次被拒尝试恰一条；`malformed_input`/`run_not_found`/`workspace_not_authorized`（跨项目不写）不落。",
  },
  {
    type: "run.delivery_repackaged",
    description: "模型无关重打包的恢复出处事实（repackage CAS 批次的 provenance 侧，与 run.delivery_created 一次 appendFile 原子落盘）：载荷含 DeliveryRef、approvedAllowedPaths（canonical/sorted/unique 闭集）、source（packaged/recovered）、recoveryKind（disallowed_scope/backend_failed/process_missing——必须与既有 durable 恢复事实一致）。",
  },
  {
    type: "run.delivery_reverification_requested",
    description: "Lead 复核请求（reverify 链首事件，恰一条）：载荷含 DeliveryRef、deliveryCommit（canonical 且等于内嵌不可变 commit）、reason ∈ REVERIFY_REASONS 闭集（tooling_invalid/environment_contaminated/dependency_setup_missing）、可选 setupCommands（≤32 条、各非空 ≤512 字符——唯一允许 Lead 增补的内容，原断言命令不可变）。重试/并发收敛到首请求者的 reason+setup（确定性验证）。",
  },
  {
    type: "run.delivery_reverification_passed",
    description: "reverify 链 outcome：passed（恰一条；与恰一条请求构成 complete 链后才改写 effective 验证状态，否则原验证结果不变）。",
  },
  {
    type: "run.delivery_reverification_failed",
    description: "reverify 链 outcome：failed（恰一条；failureCode ∈ REVERIFY_FAILURE_CODES 闭集：command_failed/command_timeout/execution_error/setup_failed/setup_timeout/setup_environment_error/artifact_mutated）。",
  },
  {
    type: "run.delivery_reverification_unavailable",
    description: "reverify 链 outcome：unavailable（恰一条；非空 unavailableReason）。",
  },
  {
    type: "run.process_missing_confirmed",
    description: "Lead 授权的孤儿进程零模型结算确认事实（常量 PROCESS_MISSING_CONFIRMED_TYPE 写出）：`wao runs settle` 写 {settledBy: \"lead_settle\", sessionShape, reason, reasonSha256}，repackage 的孤儿结算写空载荷；与 terminal failed（reason=process_missing）转移经 transitionState factEvents 原子同批落盘，恰一条；无配套转移的孤立事实不构成可恢复证明（fail-closed）。",
  },
  {
    type: "run.correction_requested",
    description: "MCP `run_correct` 的入队事件（恰一条/correctionId）：载荷 {correctionId（闭集字母表 ≤64 字符——exactly-once 键）, prompt（≤15000 字符，落盘脱敏同 prompt.sent）}；runner 重读 prompt 投递；安全查询面（run_activity）只投影 status，永不回显正文。",
  },
  {
    type: "run.correction_claimed",
    description: "runner 在 append lock 内原子认领（{correctionId}）：durable crash-safety 标记——claim 后崩溃的 correction 不再重投（no double turn），终态清扫按 terminal_race 拒绝。",
  },
  {
    type: "run.correction_delivered",
    description: "runner 已把追加轮交给 backend 的在途纠偏接口（{correctionId}）：进程类 backend 写进 provider stdin，kimi-web 经 HTTP 排队并 steer 进活动轮。\"delivered\" 只证 runtime 接受了它，不证模型执行了该轮；幂等（已 delivered 再记为 no-op）。",
  },
  {
    type: "run.correction_delivery_failed",
    description: "追加轮没有交出去（{correctionId, reason ∈ {stdin_closed, send_failed} 闭集}）：stdin 已关闭、写入被拒，或 kimi-web 排队/steer 失败；该 correction 的终态，无正文回显。kimi-web 排队成功而 steer 失败时，上游仍可能在后续轮消费该消息——send_failed 不等于一定没执行。",
  },
  {
    type: "run.correction_rejected",
    description: "终态清扫时仍未交出的追加轮被拒（{correctionId, reason}，闭集 CORRECTION_REJECTION_REASONS）：只由 rejectOutstandingCorrections 写，对已入队的 pending/claimed 项默认 terminal_race，按 correctionId 排序批量原子落盘——每个 outstanding correction 恰一条。入队时的校验拒绝只返回给调用方（{outcome: \"rejected\", reason}），不写这条事件。WAO 从不中断/抢占/自动重试，拒绝是正常闭集出口而非错误。",
  },
  {
    type: "run.upstream_session_deleted",
    description: "终态释放上游 provider 会话成功（{backendSessionId}）。",
  },
  {
    type: "run.upstream_session_already_gone",
    description: "终态释放时探测上游会话已不存在（{backendSessionId}）；absent 不等于探测失败。",
  },
  {
    type: "run.upstream_session_delete_skipped",
    description: "上游会话删除被跳过（{backendSessionId, reason}，如 busy——会话仍在忙，留给下轮）。",
  },
  {
    type: "run.upstream_session_delete_failed",
    description: "上游会话删除尝试失败（{backendSessionId, reason（闭集，兜底 http_error）, 可选 code}）；只记账，绝不逆转 run 终态。",
  },
  {
    type: "run.worktree_released",
    description: "终态回收 worktree 成功（payload 为空；以删除后 existsSync 复检为准——remove 成功且复检不在场才写）。",
  },
  {
    type: "run.worktree_already_gone",
    description: "终态回收时探测 worktree 已不在（payload 为空；absent≠探测失败，探测失败走 release_failed/skipped 形状）。",
  },
  {
    type: "run.worktree_release_skipped",
    description: "worktree 释放被跳过（{reason}）：stop_unconfirmed——只读运行的 worker 停止还没确认，留树等迟到收取；unproven_path——accept 释放时绑定事实里的路径无法证明；not_tip——accept 释放时 HEAD 不是交付 commit 的 tip，保树取证。",
  },
  {
    type: "run.worktree_release_failed",
    description: "worktree 释放失败（{reason:\"still_present\"}——删除后复检仍在，或意外抛错后复检仍在：抛错≠完好，可能已半删，按可疑处理）；绝不逆转 accepted 决定。",
  },
  {
    type: "run.worktree_branch_recycled",
    description: "worktree 释放成功后的分支回收成功（payload 为空；for-each-ref 全 refs 可达性判定无独有提交才 `branch -d`）。",
  },
  {
    type: "run.worktree_branch_kept",
    description: "分支回收判定保留（{uniqueCommits：独有提交数} 或 {reason：-d 拒绝等原因}）；分支回收失败绝不反过来污染释放结果（独立 try，事件即事实）。",
  },
  {
    type: "run.lineage_closed",
    description: "线系显式关闭（{rootRunId, reason（有界正文）, reasonSha256}——路径不替代内容）：写入后 run_continue 对该线系的续跑被拒（闭态检查读根转录 bound 事件）；已闭合重入=跳过写事实、补偿重试释放。",
  },
  {
    type: "run.lead_commit_check_started",
    description: "`runs verify-commit`（采纳协议承载）首命令前写入：checkId 随机 nonce、受检提交全形、命令清单原文 + commands-file 字节 sha256、timeoutMs、终态判定依据（准入只认终态 run.state_change；legacy 推断终态无准入资格，追加自检事件会翻转其推断状态）、提交关系事实字段（isDeliveryCommit/containsDeliveryCommit/adoptedFromTrailer，记事实不设拒）；`kind:\"lead_self_check\"` + `independentAuditRequired:true` 边界锁。仅有 started 无 outcome 是合法的不完整证据，绝不读作通过。",
  },
  {
    type: "run.lead_commit_check_outcome",
    description: "`runs verify-commit` 收口：status∈{passed,failed,aborted}、results[]（index/exitCode/timedOut/durationMs + 失败 8KiB 尾）、独立 cleanup∈{ok,failed} 字段。不做恰一条 CAS（允许多次核验，checkId 区分）；本事件族不进 validateDeliveryFacts/decide/wao accept 的任何判定输入。",
  },
  {
    type: "workflow.started",
    description: "DAG 执行开始（写独立 `wf_*.jsonl`，经 JsonlTranscript.append）：载荷 {workflowId, nodeCount, layers}；payload 冲突字段重命名保护信封（nodeRunId/nodeType/nodeAgentId）。",
  },
  {
    type: "workflow.node.started",
    description: "DAG 节点开始（`wf_*.jsonl`）：载荷 {nodeId, nodeType, nodeAgentId}——节点的 type/agentId 写盘前改名，不覆盖信封字段。",
  },
  {
    type: "workflow.node.completed",
    description: "DAG 节点完成（`wf_*.jsonl`）：载荷 {nodeId, runId→nodeRunId, completed, error?}——typed 拒绝文案（如 dispatch_cwd_not_found）随本事件落盘，是 CLI 汇总外的唯一持久诊断出口。",
  },
  {
    type: "workflow.completed",
    description: "DAG 执行完成（`wf_*.jsonl`）：载荷 {workflowId, completed, executed[], skipped[]}。",
  },
].map((entry) => Object.freeze({ legacy: false, ...entry })));

/** 已登记事件类型名（冻结数组，按登记顺序）。 */
export const TRANSCRIPT_EVENT_TYPES = Object.freeze(TRANSCRIPT_EVENT_REGISTRY.map((entry) => entry.type));

// 校验用的集合只在本模块里：冻结的 Set 仍可 .add()，导出它就能让别处绕过登记表。
const REGISTERED_TYPES = new Set(TRANSCRIPT_EVENT_TYPES);

/** 登记判定（登记表查询的唯一入口）。 */
export function isRegisteredTranscriptEventType(type) {
  return typeof type === "string" && REGISTERED_TYPES.has(type);
}

// ── 严格模式与进程级违规清单 ────────────────────────────────────────────────
//
// 违规清单按进程记账（类型 → 次数）。strict 开启时：report 函数先记账、置
// 非零退出码，再抛错（抛错被调用方吞掉时，退出码与退出钩子仍让测试红）。
// strict 关闭（生产默认）：只对每种类型往 stderr 打一次警告，随后照常
// 序列化写盘——绝不丢弃、拒绝或推迟事件。

export const TRANSCRIPT_EVENT_STRICT = process.env.WAO_TRANSCRIPT_EVENT_STRICT === "1";

const strictViolations = new Map();
const nonStrictWarned = new Set();

if (TRANSCRIPT_EVENT_STRICT) {
  process.on("exit", () => {
    if (strictViolations.size === 0) return;
    const names = [...strictViolations.entries()]
      .map(([type, count]) => `${type} x${count}`)
      .join(", ");
    process.stderr.write(
      `[transcript-events] unregistered transcript event type(s) written under WAO_TRANSCRIPT_EVENT_STRICT=1: ${names}\n`,
    );
    process.exitCode = 1;
  });
}

/**
 * 记录一次未登记类型的写出尝试。strict：记账 + 置非零退出码 + 抛错（调用
 * 方的序列化失败，事件不落盘）。非 strict：每种类型警告一次后返回，事件
 * 照常落盘。
 * @param {string} type 事件类型名（可能非字符串——如实报告）
 * @throws {Error} 仅 strict 模式
 */
export function reportUnregisteredTranscriptEventType(type) {
  const label = typeof type === "string" ? type : String(type);
  if (TRANSCRIPT_EVENT_STRICT) {
    strictViolations.set(label, (strictViolations.get(label) ?? 0) + 1);
    process.exitCode = 1;
    throw new Error(
      `unregistered transcript event type: ${JSON.stringify(label)} — add it to TRANSCRIPT_EVENT_REGISTRY in src/transcriptEvents.js (or name it in the test fixture's syntheticEventTypes allowlist)`,
    );
  }
  if (!nonStrictWarned.has(label)) {
    nonStrictWarned.add(label);
    process.stderr.write(
      `[transcript-events] warning: unregistered transcript event type written: ${label} — registry is src/transcriptEvents.js\n`,
    );
  }
}
