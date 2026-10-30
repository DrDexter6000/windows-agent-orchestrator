# 监督

> [使用手册](../usage.md)的一页：run 在跑时怎么等、怎么看状态和活动、怎么停。

本页四个 MCP 工具（`run_status`、`run_activity`、`run_stop`、`run_wait`）的参数与形状以生成层 `docs/surface/mcp-tools.md` 为准（权威源是代码，随代码再生成）；本页写完成监督需要的用法、默认值、闭集取值和边界。状态机与事件定义见 `docs/02-architecture.md`，事件表见 [transcript 格式](transcript.md)。

<a id="lead-quiet-supervision"></a>
## Lead 安静监督与续接

监督的目的，是及时发现需要决策的变化，不是证明 Lead 一直在线。以下是跨模型默认操作规则。

- **按事件汇报**：派发前说明本轮目标和边界；之后在完成、失败、实质进展、风险/阻塞变化、需要 Owner 决策或 Owner 主动询问时汇报。没有新事实/判断/决策时不反复输出"仍在运行"，不重复计划与已有结论。长任务可安静数十分钟以上；不能隐瞒已观察到的重大事项。
- **少查询、长等待**：优先 `run_await_result` 等终态提前返回的等待工具，用允许的较长窗口。到期无实质变化就继续等或拉长间隔；不要每隔几秒点查，也不要为同一状态串联 status/activity/collect/diagnose。查询完成不等于必须发用户消息。
- **安静不等于失去监督**：按观察窗口检查终态、Owner 输入与活性/异常信号。断连或超时只代表本次观察不完整；恢复后先点查原 run，不重复派发。长等待、沉默和耗时都不是自动 stop/retry 或接受交付的理由。
- **WAO 什么时候自己收口、什么时候等你决定**：口径同一条——控制面只在运行没有生命体征时因"等不到进展"自动收口，有生命体征就不替你放弃。各车道体征与落点不同，kimi-web 有一处例外：
  - **zcode**：新的动作或正文、模型流在收、工具子进程在干活、工作目录有文件变化，任一成立就继续等（无自动上限）；都没有才收口，约 5–10 分钟（判据见 [troubleshooting §6.9](../troubleshooting.md#69-zcode-运行什么时候会被控制面自动收口生命体征口径决定-0067)）。模型流在收时转录每分钟落一条 `runtime_activity`（`streaming`）；凭后两项续命时落 `process_active` / `files_changed`（每种至多每分钟一条）。
  - **kimi-web**：命令与工具调用在输入就绪后落转录、结果在工具结束时落；写文件调用在途先落一条只带路径的预告，证据与结果仍等整轮带正文完成。turn 结构有变化算进度；没有变化时等 60–240 秒问 serve 这一轮是否还活着，不活跃或问不到就收口。但自上次产出增长以来这样续命的静默满 30 分钟仍会收口（只有 steps / 帧 / 文本变多才清零，state 来回变不算）：serve 的"还活着"是自我声明，工具挂死时同样报 active，无别的体征可交叉印证。一条超过 30 分钟、期间不落任何帧的命令会被收掉。
  - **进程式后端**（codex / claude-code / kimi-code / deepseek-*）：没有"轮内等不到进展"的自动收口门——运行到进程退出或 Lead 中止（可选 `silentTimeout` 只管"启动后一条事件都没有"，默认关；deepseek 的握手等请求级超时见 `docs/surface/certification.md` 生命体征条目）。崩溃、协议错误等失败照常收口。codex / claude-code / kimi-code 在转录静默满 5 分钟后取基线、30 秒后再取一次比对，约每 5.5 分钟一轮：读到后代进程在干活落 `process_active`、工作目录有变化落 `files_changed`，没读到什么都不落——只是给 Lead 看的事实，不收口；模型长思考期间读不到体征，deepseek 两个后端未接取样。deepseek-acp 的命令在调用到达时就落一条 `tool_use`（带命令原文），`run_activity` 看得到在跑的命令；codex 等命令时会自己隔一两分钟发一句话，取样很少轮到它。

  运行未到终态、转录读取可信，且转录里 ≥30 分钟没有新的动作或正文时，三个面都会直接告诉你：CLI `status` 附一行 `advisory`；MCP `run_status` 带 `leadAdvisory`；`run_wait` / `run_await_result` 的 `semanticNotes` 带 `observation.transcript_quiet`。停不停由 Lead 决定。
- **宿主例外**：Owner 可明确要求固定频率更新；宿主更高优先级指令要求更短等待/更频繁更新时遵守并简要说明限制，把无变化更新压到最低。不要把某一宿主的频率限制变成 WAO 通用规则，也不承诺本手册覆盖宿主指令。
- **跨会话续接**：经 Owner 要求或批准，在项目本地工作笔记保留目标、授权范围、已确认事实/待证假设、证据路径、断点、下一步与停止条件，给后续 Lead 留可发现入口；只在事实或决策变化时更新，不抄轮询流水。compaction 摘要是线索，续接前重读笔记并核对 Git、WAO 查询与原始报告；笔记不能冒充运行台账、验收结果或新授权。

## MCP `run_status`（即时状态查询）

`run_status` 让 MCP host 查询一个 run 的当前状态，与 CLI `status` 复用同一 service（`getRunStatus()`），不 shell-out CLI；只读。输入只接受 `runId`（`runDir` 等控制参数 server-owned）。安全输出只返回机器标识 + 时间戳，不含内容；`lastEvent`/`lastActivity` 不存在时为 `null`。

- `lastEvent.meaning` 只对停止验证事件给出闭集解释：`runtime_quiet_verified|runtime_quiet_unverified|null`。`run.stop_verified` 的稳定含义是"worker runtime 已静默"——可能来自普通终态清理或显式 `run_stop`，不得据此推断 Lead 调过 stop。
- `agentId` 是 transcript envelope 盖戳的 canonical worker 身份（闭集字符 `[A-Za-z0-9._-]`，长度 1..128，SSOT 在 `canonicalAgentId.js`）。只有每个事件都具备与请求 `runId` 一致的 `runId` 且同一个合法 canonical agentId 才返回该 id；缺失、冲突、非法或跨 run 一律降级为 `"unknown"`——不抛错、不伪造身份、不是自动停止门，不从 worker 自由文本推断。
- 绝不返回原始 event payload、command/tool input/message/reason/error、绝对路径、PID、prompt、argv、环境变量或 `lastActivitySummary`。CLI `status` 含人类可读摘要，MCP 只暴露安全机器字段；`content` JSON 与 `structuredContent` 一致。失败返回固定文案 `run_status failed`，不拼接 message/stack/path。

## MCP `run_activity`（活动时间线下钻）

`run_activity` 是 workspace-bound、只读、幂等的活动下钻工具：从同一份 transcript 快照投影一页事实，不追加 audit、不直接返回 JSONL、不做进度估计或总结建议。

- 输入：`categories` 闭集（含 `correction`）与 `afterSeq`/`cursor` 形状以生成层为准；`pageSize` 为 1..50；`cursor` 是由上一页返回的 opaque token。
- 输出：当前 state/terminal、各类别总计、当前页 entries、`truncated`/`nextCursor` 和 `availableDrilldowns`。条目缺省最新在前（`order:"asc"` 按时间顺读；cursor 往更早翻）。各条目给的内容：
  - message：脱敏后的有界文本。command：命令原文（`text`）与 `ok|failed|unknown`——先做环境密钥值整段替换，再过形状兜底（名字像密钥的赋值/参数、`Authorization`/`Bearer`、URL 与 `curl -u` 口令、PEM 私钥块、常见令牌形状），清控制字符、截到 400 字符保留开头（`truncated`）。没有形状的秘密不在覆盖范围；绝对路径照原样。
  - tool_use：工具名 + 输入里最能说明"在对什么动手"的字段（`detail`：命令/文件/模式/查询/URL/任务 id，脱敏、200 字符；无则缺席），脱敏同命令原文。tool_result：错误布尔与输出尾部（`tail`，脱敏后取最后 400 字符，`truncated` = 清洗后长于 400）；失败工具的尾部可含报错正文。
  - 文件：只给安全 repo-relative path。`runtime_status`：闭集（`initialized|streaming|provider_retry|process_active|files_changed|serve_active|unknown`），不返回 stream delta/retry error/session/model；未知事件用固定 sentinel。
- 安全顺序：动态文本先 exact-secret redaction，再清洗 C0/C1/DEL，再截断/分页；绝不返回完整 tool input/output、error text、credential、PID、provider session。
- cursor 绑定 runId、冻结快照前缀、audience/filter/afterSeq 视图与位置；append-only 增长可继续。历史变更/收缩、跨 run/view/audience、malformed 或越界 cursor 返回有界结构化恢复结果：`status:"cursor_rejected"` + 静态 `choices`（`isError:true`、带 `structuredContent`、无首页 entries/counts/nextCursor），需显式重新请求——重新请求无 cursor 的第一页，或用已知序列中的 `afterSeq`（如 `run_wait` 的数值 cursor）重入。WAO 只呈现事实与选择，不自动重试/停止/决策，不回显 raw cursor 或动态错误。跨 workspace、无效 envelope、畸形输出返回固定通用错误（`run_activity failed`，无 structuredContent）。
- `scopeObservation`（advisory、additive）：闭集 `within_declared_paths | outside_declared_paths | unknown`；字段（`observedFileCount`、上限 25 条的脱敏 `outsidePaths` 等）与 `complete:true` 的准确语义——只说明快照已终态且每条确认的 `file_written` 都能在有效合同权威下求值，不证明文件系统完整性、语义、验收，也不表示 worker 仍在运行——见[架构](../02-architecture.md)的 scope 投影段（该口径的唯一完整家）。
- `readOnlyObservation`（advisive、additive、仅声明过只读的 run 才出现）：闭集 `no_writes_observed | writes_observed | unknown`。权威、fail-closed 与诚实读法（`writes_observed` 是运行中告警、`no_writes_observed` 不是"没写"、观察到越界写不自动停止——终审归 Lead）见[架构](../02-architecture.md)的只读声明段；cursor 续页从冻结前缀投影（append-only 稳定），新读第一页可观察后追加的写。

## MCP `run_stop`（停止运行）

`run_stop` 让 MCP host 停止一个失控的 worker run，与 CLI `stop` 复用同一 service（`runStop.js`）。destructive、目标必传——`expectedWorkspaceRoot` 给出本项目 Git 顶层，run 不属于它即拒（不读会话绑定）；不返回 PID/path/session 等跨项目探测标识。

停止之前（为什么见决定 0069；对所有车道相同）：

1. 先看它在做什么：MCP `run_activity`（缺省最新在前）；CLI `status <runId>`。
2. 最近 10 分钟内有生命体征（任何 worker 事件，含 `runtime_activity`）就不要随意中止——建议，不拦你：长测试、长思考、等后台任务都是这副样子。
3. 写明理由并带位置：MCP `run_stop({ runId, observedSeq, reason })`（`observedSeq` 取 `run_activity` 最新条目的 `seq`，没有填 0）；CLI `stop <runId> --observed-seq <n> --reason "<理由>"`（`n` 取 `status` 的 `observedSeq`）。两项记进 `run.stop_requested`，连同体征距今多久。
4. 你看的位置之后 worker 又有动作且已是 2 分钟前，或其后运行被重放过（目标换成新进程）——决定照着过时状态做的，stop 拒绝（零副作用）：重看再决定。刚落下的事件不算过时。

输入只接受 `runId`、`observedSeq`、`reason`；观察过时、其后被重放、或 `observedSeq` 不是该转录位置时以固定文案拒绝（零副作用）；只带 `runId` 会被 schema 拒绝。其余控制参数 server-owned。安全输出只返回机器标识 + 终态事实，不含路径/PID/session：

- `terminalAccepted`（first-terminal-wins 仲裁是否认领 `aborted`）、`terminalState`（终态）、`sideEffectAttempted`（是否执行了 taskkill/abort 等破坏性副作用——rejected loser 为 false）、`stopVerified`（进程式 worker 已退出，或服务端会话——OpenCode、kimi-web——已由 status + token/message 稳定性确认静默）。服务端观察面不可读时返回 unverified，不能把网络/endpoint 失败当作已停止；观察到 session 仍 active 时也只报告并告警，WAO 不自动执行会杀死其他 session 的全局 `taskkill /IM opencode.exe`。stop verification 以后置 PID 存活检查为准，不假验证（ESRCH=已退出，EPERM/未知=保守 alive）。失败返回固定安全文案 `run_stop failed`。

停止路由由会话记录的事实决定：`proc_<pid>` 占位 id 或带 `hostPid` 的会话（进程式后端，如 zcode）走进程树击杀并核验；带 `serveUrl` 的走服务端中止——opencode-serve（或未记 backend）发 OpenCode 的中止，kimi-web 中止会话正在跑和排队的 prompt，鉴权用 registry 里派发该运行的 agent（`run.started.agentId`）。该 agent 取不到（registry 不可读/不在册）、token 取不到（token 文件或环境变量：先进程环境、再 Windows 用户环境）、与会话记录对不上（backend/`serveUrl` 不同），或 backend 无服务端中止时：什么都不发、不认领终态，记 `run.stop_unverified`（`outcome:"stop_route_unavailable"`）并告警，返回 `terminalAccepted:false`、原状态、`sideEffectAttempted:false`——worker 还在跑，需修好 registry 再停或手动处理（CLI 另带该 outcome 与固定说明）。resume 重放过的运行目标取 `run.rerun` 的新会话/新进程，不取旧进程；皆无时报 `has no stop route` 并点名后端，需手动结束进程树。会话查找与 agentId 读取都是 runId 绑定读取（末条绑定），外 run 伪造 `session.created` 夺不走 kill 目标；信封前的 legacy transcript 落入 `no session metadata` 拒绝面。

CLI fallback：`npm run cli -- stop <runId> --observed-seq <n> --reason "<理由>"`（`n` 取 `status <runId>` 输出的 `observedSeq`；缺任一项即报错并给出这两步）。

## MCP `run_wait`（长等待）

`run_wait` 让 MCP host 以 long-poll 等待一个 run 到终态或产出 liveness 摘要，避免 busy `run_status` 轮询。与 CLI 长等待复用同一 service（`runWait.js` + owner 心跳 SSOT `ownerLiveness.js`），不 shell-out CLI；只读——不追加 transcript、不改 terminal state。`run_await_result` 是同一等待的取结果形态（终态附 compact 结果），语义同本节。

`runId` 必填；`runDir`、registry、`force`、timeout 等控制面参数是 server-owned。`afterSeq`（整数 ≥0，可选）：

- 省略：以首次读取时的最大 `seq` 为基线——只统计窗口内的新进展，不把历史误报为 progress。
- 显式 `0` 或正整数：统计 `seq > afterSeq` 的全部进展（含历史），用于续读——把上次返回的 `cursor` 传回即可。

`waitMs` 是 Lead 的单次观察窗口：30000..600000，MCP 缺省 45000（CLI 有界 `runs wait` 缺省 270000）；`waitMs:0` 有意无效——point-in-time 读取用 `run_await_result({waitMs:0})` 或 `run_status`。窗口到期只返回 liveness，不表示 worker 失败，也不会中止 worker。返回时机只有两种：run 到达终态（completed/failed/aborted/timed_out，`returnedEarly:true`）；或 `waitMs` 到期仍未终态（`returnedEarly:false`，附带 liveness 摘要让 Lead 决定下一步）。普通新事件不会触发提前返回——只有终态会；窗口内的新进展通过到期的 liveness=`progress` 体现。若返回 `terminal:true`，该终态事实已足够，Lead 直接进入 `run_collect`（无交付的 run 不需要再调用一次 `run_status`）；请求了交付的 run 在终态后继续等交付收口（见下节），不跳过 `run_delivery`。

状态投影与 liveness 计数都按 runId 绑定（全无信封的 legacy 快照除外，其活动计数仍按全部事件统计）：`run_wait` / `run_await_result` 只看本 run 信封事件（初始读与每次 poll 同一过滤）——外 run 高 seq 活动行不伪造 `progress`，尾部伪造 `run.state_change` 不把等待翻成终态、也不阻断终态观察。全无信封的 legacy transcript 状态投影降级 `pending`，不可归属永不投影为终态——不 throw、不转 read_failure，窗口如实耗尽后返回非终态。CLI `runs wait` 的 Ctrl-C 中断快照同款绑定。

安全有界输出只返回机器字段 + liveness 摘要，不含内容/路径/session。字段语义：

- `state`：从 transcript 投影的当前状态（含 `unknown`）；`terminal`：是否终态；`cursor`：已观测到的最大 `seq`（下次 `afterSeq` 的续读点；读失败 `null`）；`returnedEarly`：`true` = 终态提前返回，`false` = `waitMs` 到期。
- `observationOutcome`：闭集 `observed` / `read_failure`（快照不可读/不可信——fail-closed，不把陈旧事件 liveness 与新鲜 owner 心跳拼成"看似当前"的观测）；`readFailureReason` 仅在 read_failure 时为闭集机器码（`transcript_parse_failed`/`legacy_event_shape`/`snapshot_unavailable`），否则 `null`，绝不带 error message/path/command/credential。
- `liveness`（读失败 `unknown`）、`activityEventCount`（相对 baseline 的证据事件数，读失败 `null`）、`lastActivityKind`（最近一条证据事件的闭合安全标签：`message`/`thinking`/`command`/`tool_use`/`tool_result`/`file_written`/`runtime_status`/`metrics`/`state`/`delivery`/`scorecard` 等，无则 `null`）。
- `ownerHeartbeat`：字符串枚举——`"fresh"`/`"stale"`（.owner 心跳在/不在阈值内）/`"n/a"`（终态返回）/`"unknown"`（读失败不查心跳）。
- `observation`：`{ outcome, waitedMs, windowMs }`，`outcome ∈ { point_in_time, window_expired, terminal, read_failure }`——区分"窗口到期""终态""读失败"；到期绝不意味着 worker 已停止。
- `termination`：仅干净观测到终态时非空（`{ state, source, configuredMs, policySource }`），否则 `null`。`source ∈ { completion, execution_deadline, manual, provider, backend, control_plane, unknown }`：`execution_deadline` 仅当 wall-clock 截止定时器真的触发（有 bound `run.timed_out` 事实），否则 `timed_out` 态降级 `unknown`——Lead 不会误判 WAO 停了 worker；`configuredMs`/`policySource` 来自绑定的 `run.wait_policy`（缺失/冲突/畸形 → `null`/`unknown`，缺失不等于 disabled）。
- `agentId`：envelope 盖戳的 canonical worker 身份（同 `run_status`，缺失/冲突降级 `"unknown"`）；`availableDrilldowns`：静态有界披露（`run_activity`/`run_diagnose`/`run_collect`），不自动调用、不停止 run。

`liveness` 取值（从 transcript 事件流 + owner 心跳投影，不引 isAlive）：

- `terminal` —— run 已到终态（completed/failed/aborted/timed_out）。
- `progress` —— baseline 之后有证据事件（message/command/tool_use/tool_result/file_written/payload-free runtime status/`run.metrics`），worker 在产出。
- `process_only` —— baseline 之后无证据事件，但 owner 心跳新鲜（worker 进程仍在，疑似思考或卡顿）。
- `silent` —— baseline 之后无证据事件，且 owner 心跳过时或不存在（排队或疑似卡住）。

`run.metrics`（token/cost tick）算作进展，但其原始 token/cost 数值绝不返回——只暴露 `lastActivityKind:"metrics"`。证据事件的闭集由 `runWait.js` 所有；`ownerLiveness.js` 只负责心跳新鲜度 SSOT，不是完整 liveness 投影 SSOT。

绝不返回原始 event payload、command/tool input/message/reason/error 内容、绝对路径、PID、prompt、argv、环境变量、token/cost 原值。`content` 的 JSON 与 `structuredContent` 语义一致。service 失败时返回固定安全文案 `run_wait failed`，不泄漏 zod 校验信息。

transport keepalive：MCP SDK 的请求超时可能短于观察窗口。client 通过 `onprogress` 请求进度时，server 每次 poll 后向该 `progressToken` 发标准 `notifications/progress`；client 设 `resetTimeoutOnProgress:true` 则每条进度重置自身计时器。标准 MCP 机制，不 patch host、不改全局 timeout；最大总超时仍由 host 决定。host 不请求进度时 server 不发通知。

transport 恢复契约：`run_wait` / `run_await_result` 都是只读 advisory 工具。一次调用没有返回结果（transport drop/超时被 host 中断）时观察状态是 unknown——没有 control-plane 变更、没有停止 worker；恢复方式是 point-in-time 重读（`run_await_result(waitMs:0)` 或 `run_status`）。绝不能从 transport 丢失推断 worker 是 alive 还是 dead；只有干净观测到的终态（`termination` 非空）才陈述终止事实，且来源是闭集 `termination.source`，不是猜测。

三个互相独立的时钟（执行截止、后端请求超时、Lead 观察等待）的职责划分见 [架构](../02-architecture.md) 的"三钟分离"；`run_wait` 的 `waitMs`（区间与缺省见上）只决定一次调用等多久，不影响 worker 生命周期。

CLI fallback：MCP `run_wait` 与 CLI `runs wait <runId> [--wait-ms N]` 共用同一等待服务；要一直等到收口用 `runs wait <runId> --until-settled`（见下节）。`status` 轮询或 `tail --follow` 也能拼出观察，但语义不等同。

## 等待到收口：`runs wait --until-settled` 与 `nextStep`（决定 0095）

**收口（settled）**是同一份可信快照上的闭集判定：运行已终态；有交付时，原始验证与最新 reverify 链都已有结果。未请求交付、打包失败、隔离失败都算收口；事实校验 malformed、原始验证尚无结果却已有 reverify 事实、reverify malformed、孤立 reverify 链、终态后既无 `delivery_created` 也无 `delivery_failed`（常见于打包前就失败或被停的运行）是"无法判定"。收口不含"验证通过""Lead 已验收""WAO 收尾已完成"——`verification passed is not acceptance` 恒成立。

`wao runs wait <runId> --until-settled`（与 `--wait-ms` 互斥）：每 15 秒一轮，重新解析路径、读新快照、判定一次；只读、不停 worker、不设总时长。退出码：`0` 收口（终行带验证结果与 `nextStep`；JSON `{ settled, runId, state, settlement, nextStep }`）；`3` 连续 4 轮不可信或无法判定（读取失败、副本读不出、未找到，或交付事实不能收口；后者先报运行状态，再指向 `runs diagnose` 与 `runs delivery`），或 `verifier_gone`（终态等验证的后台运行已无验证进程；不可重试；JSON 以 `reason` 与本轮的不可信面区分，附 `basis` 与 `nextStep`）；`4` 持久冲突（多副本内容不同，立即退出）；`130` SIGINT（只输出一份标注快照读取时间的结果）。同一等待器每 5 分钟至多证明一次，成立后重新解析、重读、再判一次：已收口照常退出 0，仍等验证才退出 3。诚实边界：只保证收口时退出——能否因此唤醒 Lead 取决于宿主；仍会一直挂着：前台运行（验证在 `wao run` 进程里跑，转录不记 pid）、resumed 运行（`run.rerun`）、reverify 请求后进程死了（再调一次 `wao runs delivery reverify` 会接着跑）、证明不成立（租约损坏、身份判不了、有活 daemon、进程扫描失败——本机有读不到命令行、且晚于本运行创建的 node 进程）。非终态满 30 分钟未见新体征时进度行给出 `runs settle`/`stop`（只在 Lead 决定时用）。进度：文本写 stdout，`--format json` 时写 stderr、stdout 只留最终 JSON；只在首轮、状态或原因变化、不可信轮及其后一轮、距上一行满 5 分钟时打印。

`nextStep` 是没等到收口时附的一句固定英文模板：MCP 面只写工具名、不含 runId；CLI 面写命令、带 runId。按体征年龄分档，阈值与安静监督同源。MCP 等待族的缺省与区间见各工具描述；`run_delivery` 带 waitMs 的等待由收口判定决定——"验证中拒收"与"reverify pending"两种 readiness 显示 reviewable 但未收口的状态也会真正等待（区间与缺省见[交付](delivery.md)）。
