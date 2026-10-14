# 监督

> [使用手册](../usage.md)的一页：run 在跑时怎么等、怎么看状态和活动、怎么停。

本页四个 MCP 工具（`run_status`、`run_activity`、`run_stop`、`run_wait`）的参数与形状以生成层 `docs/surface/mcp-tools.md` 为准（权威源是代码，随代码再生成）；本页写完成监督需要的用法、默认值、闭集取值和边界。状态机与事件定义见 `docs/02-architecture.md`，事件表见 [transcript 格式](transcript.md)。

<a id="lead-quiet-supervision"></a>
## Lead 安静监督与续接

监督的目的，是及时发现需要决策的变化，不是证明 Lead 一直在线。以下是跨模型默认操作规则。

- **按事件汇报**：派发前说明本轮目标和边界；之后在完成、失败、实质进展、风险/阻塞变化、需要 Owner 决策或 Owner 主动询问时汇报。没有新事实、新判断或新决策时，不反复输出"仍在运行""继续等待"，不重复计划、数字和已有结论。正常长任务可保持数十分钟乃至更久的安静；不能隐瞒已观察到的重大事项。
- **少查询、长等待**：优先 `run_await_result` 等会在终态提前返回的等待工具，使用工具和宿主允许的较长观察窗口。窗口到期而状态无实质变化时，继续等待或逐步拉长查询间隔；不要每隔几秒点查，也不要为同一状态串联 status/activity/collect/diagnose。只有明确需要快速决策或验证新异常时才缩短窗口。查询完成不等于必须发一条用户消息；详细证据只在需要时展开。
- **安静不等于失去监督**：按观察窗口检查终态、Owner 输入及新的活性/异常信号。工具断连或观察超时只代表本次观察不完整，不代表任务停止；恢复后先点查原 run，不重复派发。长等待、沉默和耗时都不是自动 stop/retry、提高执行超时或接受交付的理由。
- **WAO 什么时候自己收口、什么时候等你决定**：口径是同一条——控制面只在运行没有生命体征时因"等不到进展"自动收口，有生命体征就不替你放弃。各车道读得到的体征不同，落点也不同，kimi-web 有一处例外：
  - **zcode**：新的动作或正文、模型流在收、工具子进程在干活、工作目录里有文件变化，任一成立就继续等，这一项没有自动上限；都没有才收口，约 5–10 分钟（判据详见 [troubleshooting §6.9](../troubleshooting.md#69-zcode-运行什么时候会被控制面自动收口生命体征口径决定-0067)）。模型流在收时转录每分钟落一条 `runtime_activity`（`streaming`）；凭后两项续命时落 `process_active` / `files_changed`（每种至多每分钟一条）。
  - **kimi-web**：命令与工具调用在输入就绪后落转录、结果在工具结束时落；写文件调用在途先落一条只带路径的预告，写文件的证据与结果仍等整轮带着正文完成。turn 结构有变化算进度；没有变化时等 60–240 秒问 serve 这一轮是否还活着，不活跃或问不到就收口，活着就继续等。但自上次产出增长以来这样续命的静默满 30 分钟仍会收口（只有 steps / 帧 / 文本变多才清零，state 来回变不算）：serve 的"还活着"是它的自我声明，工具挂死时同样报 active，没有别的体征可以交叉印证。一条超过 30 分钟、期间不落任何帧的命令在这条车道上会被收掉。
  - **进程式后端**（codex / claude-code / kimi-code / deepseek-*）：没有"轮内等不到进展"这类自动收口门——运行到进程自己退出或 Lead 中止为止（可选的 `silentTimeout` 只管"启动后一条事件都没有"，默认关；deepseek 另有请求级的 15s 超时）。崩溃、协议错误等失败照常收口。codex / claude-code / kimi-code 在转录静默满 5 分钟后取一次基线、30 秒后再取一次比对，约每 5.5 分钟一轮：读到后代进程在干活落 `process_active`、读到工作目录有文件变化落 `files_changed`，没读到就什么都不落——只是给 Lead 看的事实，读到什么都不收口；模型长思考期间读不到体征，deepseek 两个后端没有接这项取样。deepseek-acp 的命令在调用到达时就落一条 `tool_use`（带命令原文），`run_activity` 在命令还在跑时看得到它。codex 在等命令时会自己隔一两分钟发一句话，取样很少轮到它。

  运行未到终态、转录读取可信，且转录里 ≥30 分钟没有新的动作或正文时，三个面都会直接告诉你：CLI `status` 附一行 `advisory`；MCP `run_status` 带 `leadAdvisory`；`run_wait` / `run_await_result` 的 `semanticNotes` 带 `observation.transcript_quiet`。停不停由 Lead 决定。
- **宿主例外**：Owner 可明确要求固定频率更新；若宿主的更高优先级指令要求更短等待或更频繁更新，应遵守并简要说明限制，将无变化更新压缩到最低必要程度。不要把某一宿主的频率限制变成 WAO 通用规则，也不要承诺本手册能覆盖宿主指令。
- **跨会话续接**：经 Owner 要求或批准，在项目本地工作笔记保留目标、已授权范围、已确认事实/待证假设、证据路径、当前断点、下一步和停止条件，并给后续 Lead 留可发现的入口。只在这些事实或决策变化时更新，不抄录轮询流水。compaction 摘要是线索，续接前应重读笔记并核对 Git、WAO 查询和原始报告；笔记不能冒充运行台账、验收结果或新授权。

## MCP `run_status`（即时状态查询）

`run_status` 让 MCP host 查询一个 run 的当前状态。它与 CLI `status` 复用同一个 application service（`getRunStatus()`），不 shell-out CLI。只读——不写 transcript、不修改任何持久状态。

输入只接受 `runId`——`runDir` 等控制参数是 server-owned，模型不能传。安全输出只返回机器标识 + 时间戳，不含任何内容；`lastEvent`/`lastActivity` 在不存在时为 `null`。

- `lastEvent.meaning` 只对停止验证事件给出安全闭集解释：`runtime_quiet_verified|runtime_quiet_unverified|null`。`type:"run.stop_verified"` 的稳定含义是"worker runtime 已静默"——它可能来自普通终态清理，也可能来自显式 `run_stop`，不得据此推断 Lead 调过 stop。
- `agentId` 是 transcript envelope 盖戳的 canonical worker 身份（闭集字符 `[A-Za-z0-9._-]`，长度 1..128，SSOT 在 `canonicalAgentId.js`）。只有每个事件都具备与请求 `runId` 一致的 `runId` 且同一个合法 canonical agentId 才返回该 id；缺失、冲突、非法或跨 run 一律降级为 `"unknown"`——不抛错、不伪造身份、不是自动停止门，不从 worker 自由文本推断。
- 绝不返回原始 event payload、command/tool input/message/reason/error 内容、绝对路径、PID、prompt、argv、环境变量或 `lastActivitySummary`。CLI `status` 输出含人类可读摘要（含命令名/文件名），MCP 只暴露安全的机器字段。`content` 的 JSON 与 `structuredContent` 语义一致。service 失败时返回固定安全文案 `run_status failed`，不拼接异常 message/stack/path。

## MCP `run_activity`（活动时间线下钻）

`run_activity` 是 workspace-bound、只读、幂等的活动下钻工具。它从同一份 transcript 快照投影一页事实，不追加 audit，不直接返回 JSONL，也不做进度估计、总结、建议或下一步裁决。

- 输入：`categories` 闭集（含 `correction`）与 `afterSeq`/`cursor` 形状以生成层为准；`pageSize` 为 1..50；`cursor` 是由上一页返回的 opaque token。
- 输出：当前 state/terminal、各类别总计、当前页 entries、`truncated`/`nextCursor` 和 `availableDrilldowns`。条目缺省最新在前（`order:"asc"` 按时间顺读；cursor 往更早翻）。各条目给的内容：
  - message：脱敏后的有界文本。
  - command：命令原文（`text`）与 `ok|failed|unknown`。命令原文先做环境密钥值的整段替换，再过一层形状兜底（名字像密钥的赋值与命令行参数、`Authorization` / `Bearer`、URL 与 `curl -u` 里的口令、PEM 私钥块、常见令牌形状），然后清控制字符、截到 400 字符保留开头（`truncated` 标记是否截过）。没有形状的秘密不在覆盖范围内；命令里的绝对路径照原样给出。
  - tool_use：工具名，与输入里最能说明"在对什么动手"的那一个字段（`detail`：命令 / 文件 / 模式 / 查询 / URL / 任务 id，脱敏、200 字符；没有则缺席）。输入摘要走与命令原文相同的两层脱敏，摘要里的路径照原样给出。
  - tool_result：错误布尔与输出的尾部（`tail`，完整输出脱敏后取最后 400 字符，`truncated` = 脱敏清洗后的文本长于 400 字符）。失败工具的输出尾部可以含报错正文。
  - 文件：只给安全 repo-relative path，不给绝对路径。
  - `runtime_status`：闭集状态（`initialized|streaming|provider_retry|process_active|files_changed|serve_active|unknown`），不返回 stream delta/retry error/session/model。未知事件只用固定 sentinel。
- 安全顺序：完整动态文本先 exact-secret redaction，再清洗 C0/C1/DEL，再截断/分页。绝不返回完整的 tool input/output、error text、credential、PID、provider session。
- cursor 绑定 runId、冻结快照前缀、audience/filter/afterSeq 视图和位置；append-only 增长可继续。历史变更/收缩、跨 run/view/audience、malformed 或越界 cursor 返回有界结构化恢复结果：闭集事实 `status:"cursor_rejected"` + 静态 `choices`（`isError:true` 且携带 `structuredContent`），不含任何首页 entries/counts/nextCursor，需显式重新请求。恢复选择：重新请求无 cursor 的第一页（全新 cursor 链），或用已知 wait/activity 序列中的 `afterSeq`（如来自 `run_wait`/`run_await_result` 的数值 cursor）重入。WAO 只呈现事实与选择——不自动重试、不自动重启分页、不停止、不改写或替 Lead 决策，也不回显 raw cursor、不匹配子类型、run/workspace 路径或动态错误文本。跨 workspace 访问、无效 transcript envelope、畸形 snapshot/output、输出校验失败及未预期内部错误返回固定通用错误（`run_activity failed`，无 structuredContent）。Lead 可任意时点重复读第一页，或沿 `nextCursor` 逐页下钻。
- `scopeObservation`（advisory、additive）：闭集 `within_declared_paths | outside_declared_paths | unknown`；`source` 恒为 `"transcript_file_events"`，附 `observedFileCount`、`outsidePaths`（脱敏后的安全 repo-relative 路径，上限 25 条）/`outsidePathCount`/`outsidePathsTruncated`。`complete:true` 只说明：观察到的 transcript 快照已是终态，且该快照中每一条确认的 `file_written` 路径都能在恰好一个有效合同权威（绑定 runId 的 `run.started` 绝对 worktreePath + 非空合法 `delivery.allowedPaths`）下求值；它不证明文件系统完整性、语义正确性、交付验证或 Lead 验收，也不表示 worker 仍在运行。快照未终态或任一确认路径无法求值 → `unknown`（`complete:false`）。
- `readOnlyObservation`（advisive、additive、仅声明过只读的 run 才出现）：闭集 `no_writes_observed | writes_observed | unknown`；`source` 恒为 `"transcript_file_events"`，附 `observedFileCount`、`writtenPaths`（脱敏后的安全 repo-relative 路径，上限 25 条）/`writtenPathCount`/`writtenPathsTruncated`。权威 = 恰好一条绑定的 `run.started`（绝对 worktreePath）+ 恰好一条绑定的 `run.read_only_declared`；任一 file_written 路径无法在 worktree 下求值、权威缺失/歧义、声明缺失/重复/跨 run → 整体 `unknown`（fail-closed）。读法：它报的是当前快照观察——非终态快照也可 `writes_observed`（运行中告警，呈现不等于动作）；`no_writes_observed` 是"未观察到写"（基于工具上报证据），不是"没写"；`complete:true` 仅当快照终态且全部可求值。观察到越界写不自动停止、不失败、不改写自然终态——纯 advisory，终审归 Lead。cursor 续页从冻结前缀投影（append-only 稳定），新读第一页可观察后追加的写。

## MCP `run_stop`（停止运行）

`run_stop` 让 MCP host 停止一个失控的 worker run。它与 CLI `stop` 复用同一个 application service（`runStop.js`），不 shell-out CLI。destructive、workspace-bound——只允许停止 host-authorized workspace 绑定范围内的 run，不属于时拒绝；不返回 PID/path/session 等可被用于跨 workspace 探测的标识。

停止之前（为什么见决定 0069；对所有车道相同）：

1. 先看它在做什么：MCP `run_activity`（缺省最新在前——最近的发言、命令原文、工具名、写了哪些文件、生命体征）；CLI `status <runId>`（最近一条活动的摘要）。
2. 最近 10 分钟内有生命体征（任何一条 worker 事件，含 `runtime_activity`）就不要随意中止。这是建议，不拦你：长测试、长思考、等后台任务都是这副样子。
3. 写明理由，并带上你看到的位置：MCP `run_stop({ runId, observedSeq, reason })`，`observedSeq` 取 `run_activity` 最新一条的 `seq`（没有条目填 0）；CLI `stop <runId> --observed-seq <n> --reason "<理由>"`，`n` 取 `status` 输出的 `observedSeq`。两项都记进 `run.stop_requested`，连同"最近一次生命体征距今多久"。
4. 你看到的位置之后 worker 又有了动作、且那已经是 2 分钟以前的事，或者那之后运行被重放过（停止目标换成了新进程）——说明决定是照着过时的状态做的，stop 会被拒（零副作用）：重新看一遍再决定。刚落下的事件不算过时。

输入只接受 `runId`、`observedSeq`、`reason`；观察过时、其后运行被重放过、或 `observedSeq` 不是该运行转录里的位置时以固定文案拒绝，零副作用。只带 `runId` 的调用会被 schema 拒绝。`runDir`、`force`、registry、timeout 等控制参数是 server-owned。安全输出只返回机器标识 + 终态事实，不含路径/PID/session：

- `terminalAccepted`（first-terminal-wins 仲裁是否认领 `aborted`）、`terminalState`（终态）、`sideEffectAttempted`（是否执行了 taskkill/abort 等破坏性副作用——rejected loser 为 false）、`stopVerified`（进程式 worker 已退出，或 OpenCode session 已由 status + token/message 稳定性确认静默）。OpenCode 观察面不可读时返回 unverified，不能把网络/endpoint 失败当作已停止；观察到 session 仍 active 时也只报告并告警，WAO 不自动执行会杀死其他 session 的全局 `taskkill /IM opencode.exe`。stop verification 以后置 PID 存活检查为准，不假验证（ESRCH=已退出，EPERM/未知=保守 alive）。失败返回固定安全文案 `run_stop failed`。

停止走哪条路由由会话记录的事实决定：`proc_<pid>` 占位会话 id，或会话记录带 `hostPid`（会话 id 是 provider 原生 id 的本机进程式后端，如 zcode），走进程树击杀并核验；会话记录带 `serveUrl` 的走服务端中止。resume 以新进程重放过的运行，目标取重放记录（`run.rerun`）里的新会话与新进程，不取已被替换的旧进程。皆无时报 `has no stop route` 并点名后端——此时需手动结束进程树。会话查找（`session.created`）与 agentId 读取（`run.started`）都是 runId 绑定读取（末条绑定），尾部追加的外 run 伪造 `session.created` 夺不走 kill 目标进程；信封时代之前的 legacy transcript（事件无 `runId` 字段）落入 `no session metadata` 拒绝面。

CLI fallback：`npm run cli -- stop <runId> --observed-seq <n> --reason "<理由>"`（`n` 取 `status <runId>` 输出的 `observedSeq`；缺任一项即报错并给出这两步）。

## MCP `run_wait`（长等待）

`run_wait` 让 MCP host 以 long-poll 方式等待一个 run 到达终态或产出 liveness 摘要，避免 busy `run_status` 轮询。它与 CLI 长等待复用同一个 application service（`runWait.js`，读 transcript + owner 心跳新鲜度 SSOT `ownerLiveness.js`），不 shell-out CLI。只读——不追加 transcript event、不修改 terminal state、不改变 run 生命周期。`run_await_result` 是同一等待能力的取结果形态（终态时附带 compact 结果），等待语义与本节相同。

`runId` 必填；`runDir`、registry、`force`、timeout 等控制面参数是 server-owned。`afterSeq`（整数 ≥0，可选）：

- 省略：service 把首次读取 transcript 时的最大 `seq` 作为基线——只统计等待窗口内出现的新进展，不把历史事件误报为 progress（首轮 poll 的默认行为）。
- 显式 `0` 或正整数：统计 `seq > afterSeq` 的全部进展（含历史），用于续读。把上次返回的 `cursor` 当 `afterSeq` 传回即可增量续读。

`waitMs` 是 Lead 的单次观察窗口：180000..600000，默认 270000；`waitMs:0` 有意无效——point-in-time 读取用 `run_await_result({waitMs:0})` 或 `run_status`。窗口到期只返回 liveness，不表示 worker 失败，也不会中止 worker。返回时机只有两种：run 到达终态（completed/failed/aborted/timed_out，`returnedEarly:true`）；或 `waitMs` 到期仍未终态（`returnedEarly:false`，附带 liveness 摘要让 Lead 决定下一步）。普通新事件不会触发提前返回——只有终态会；窗口内的新进展通过到期的 liveness=`progress` 体现。若返回 `terminal:true`，该终态事实已足够，Lead 直接进入 `run_collect`；除恢复、独立复核或没有 wait 结果外，不需要再调用一次 `run_status`。

状态投影与 liveness 计数都按 runId 绑定（全无信封的 legacy 快照除外：它的活动计数仍按全部事件统计）：`run_wait` 与 `run_await_result` 只看本 run 信封事件（初始读与等待循环内每次 poll 同一过滤）——等待窗口内外 run 高 seq 活动行不伪造 `progress`，尾部追加的外 run/伪造 `run.state_change` 不把等待翻成终态、也不阻断终态观察。全无信封的 legacy transcript（事件无 `runId` 字段）状态投影降级为 `pending`，不可归属状态永不投影为终态——不 throw、不转 read_failure，等待窗如实耗尽后如实返回非终态。CLI `runs wait` 等待期间 Ctrl-C 打印的中断快照同款绑定：外 run 伪终态尾条不把中断快照翻成终态。

安全有界输出只返回机器字段 + liveness 摘要，不含内容/路径/session。字段语义：

- `state`：从 transcript 投影的当前状态（含 `unknown`）。
- `terminal`：是否已到终态。
- `cursor`：返回时已观测到的最大 `seq`，作为下次 `afterSeq` 的续读点（读失败时为 `null`）。
- `returnedEarly`：`true` = 因终态提前返回；`false` = `waitMs` 到期返回。
- `observationOutcome`：闭集 `observed` / `read_failure`。`read_failure` 表示 snapshot 无法读取/不可信——fail-closed：不把陈旧事件 liveness 与新鲜 owner 心跳拼成"看似当前"的观测。
- `readFailureReason`：仅 `observationOutcome==="read_failure"` 时为闭集机器码（`transcript_parse_failed`/`legacy_event_shape`/`snapshot_unavailable`），否则 `null`；绝不带 error message/path/command/credential。
- `liveness`（读失败时为 `unknown`）与 `activityEventCount`（相对 baseline 的证据事件数，读失败时为 `null`）。
- `lastActivityKind`：最近一条证据事件的闭合安全标签（`message`/`thinking`/`command`/`tool_use`/`tool_result`/`file_written`/`runtime_status`/`metrics`/`state`/`delivery`/`scorecard` 等）；不存在为 `null`。
- `ownerHeartbeat`：owner 心跳新鲜度投影，字符串枚举（不是对象）——`"fresh"`（.owner 文件存在且心跳在阈值内）/`"stale"`（存在但过时）/`"n/a"`（终态返回，无 owner 概念）/`"unknown"`（读失败，不查心跳）。
- `observation`：`{ outcome, waitedMs, windowMs }`，`outcome ∈ { point_in_time, window_expired, terminal, read_failure }`——清楚区分"窗口到期"与"终态"与"读失败"；一个到期的观察窗口绝不意味着 worker 已停止。
- `termination`：`null`（非终态/读失败/窗口到期），或 `{ state, source, configuredMs, policySource }`——仅在干净观测到终态时非空。`source ∈ { completion, execution_deadline, manual, provider, backend, control_plane, unknown }` 说明谁/什么导致终态：`execution_deadline` 仅当 WAO 的 wall-clock 截止定时器真的触发（有 bound `run.timed_out` 事实）——没有该事实的 `timed_out` 态降级为 `unknown`，Lead 不会误判 WAO 停了 worker。`configuredMs`/`policySource` 来自绑定的 `run.wait_policy` 事实（缺失/冲突/畸形 → `null`/`unknown`，缺失不等于 disabled）。
- `agentId`：transcript envelope 盖戳的 canonical worker 身份（同 `run_status`：缺失/冲突降级为 `"unknown"`，不抛错、不伪造身份、不是自动停止门，不从 worker 自由文本推断）。
- `availableDrilldowns`：静态有界披露，告诉 Lead 需要时可下钻 `run_activity`/`run_diagnose`/`run_collect`；不包含 worker 动态文本，不自动调用工具或停止 run。

`liveness` 取值（从 transcript 事件流 + owner 心跳投影，不引 isAlive）：

- `terminal` —— run 已到终态（completed/failed/aborted/timed_out）。
- `progress` —— baseline 之后有证据事件（message/command/tool_use/tool_result/file_written/payload-free runtime status/`run.metrics`），worker 在产出。
- `process_only` —— baseline 之后无证据事件，但 owner 心跳新鲜（worker 进程仍在，疑似思考或卡顿）。
- `silent` —— baseline 之后无证据事件，且 owner 心跳过时或不存在（排队或疑似卡住）。

`run.metrics`（token/cost tick）算作进展，但其原始 token/cost 数值绝不返回——只暴露 `lastActivityKind:"metrics"`。证据事件的闭集由 `runWait.js` 所有；`ownerLiveness.js` 只负责心跳新鲜度 SSOT，不是完整 liveness 投影 SSOT。

绝不返回原始 event payload、command/tool input/message/reason/error 内容、绝对路径、PID、prompt、argv、环境变量、token/cost 原值。`content` 的 JSON 与 `structuredContent` 语义一致。service 失败时返回固定安全文案 `run_wait failed`，不泄漏 zod 校验信息。

transport keepalive：MCP SDK 的请求超时可能短于 270s 默认观察窗口。为避免 client 在 server 仍正常观察时超时，server 在每次 poll 后向请求关联的 `progressToken` 发送标准 `notifications/progress`（仅当 client 通过 `onprogress` 请求了进度时）；client 若设 `resetTimeoutOnProgress:true`，每收到一条进度就重置自身计时器。这是标准 MCP 机制，不 patch host、不改全局 timeout；client 的最大总超时仍由 host 自己决定。host 不请求进度时 server 不发通知，client 仍受其超时约束。

transport 恢复契约：`run_wait` / `run_await_result` 都是只读 advisory 工具。一次调用没有返回结果（transport drop/超时被 host 中断）时，观察状态是 unknown——这两个工具没有做任何 control-plane 变更，也没有停止 worker。恢复方式是 point-in-time 重读：再调一次 `run_await_result(waitMs:0)` 或 `run_status`。绝不能从 transport 丢失推断 worker 是 alive 还是 dead；只有干净观测到的终态（`termination` 非空、`observation.outcome==="terminal"`）才陈述终止事实，且终止来源是闭集 `termination.source`，不是从 transport 状态猜测。

三个互相独立的时钟，不要混淆：

1. 执行截止（execution deadline）：worker run 上的 wall-clock 终止时钟，默认禁用——WAO 不用 wall-clock 杀 worker，改由 Lead 观察驱动；显式配置时仍生效。
2. 后端请求超时（backend request timeout）：单次后端调用（HTTP/进程 spawn/collect 拉取）的网络/IO 超时，与 run 生命周期正交，按 `config.timeout` 链生效。
3. Lead 观察等待（`run_wait`）：Lead 侧的 long-poll 阻塞上限（`waitMs`，默认 270s、下限 180s），只决定 Lead 一次调用等多久，不影响 worker 生命周期。到时返回当前 liveness 让 Lead 决定继续等/collect/stop。

CLI fallback：`run_wait` 是 MCP-first 能力，等价的 CLI 长等待可由 `status` 轮询或 `tail --follow` 拼出，但语义不等同。
