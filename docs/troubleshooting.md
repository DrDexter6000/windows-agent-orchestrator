# Troubleshooting（运维诊断手册）

> 定位：本文件是 WAO 运维/诊断的按需读取层。SKILL.md 是 agent 入口层（每次加载技能都读）；
> 本文件是出问题时第一时间读的诊断手册——记录已知的故障模式、根因、诊断套路、修复方法。
>
> SKILL.md 的避坑小节（opencode-serve operations & pitfalls）讲"避免踩坑"的预防知识；
> 本文件讲"已经踩坑了怎么诊断"的排障知识。两者互补。
>
> 新发现的坑按 symptom/root-cause/fix 三段式追加到对应章节末尾，保持本文件持续更新。

---

## 快速索引（按症状）

| 症状 | 去哪看 |
|------|--------|
| worker 卡 `submitted` 直到超时 | [§1 provider 故障](#1-provider-故障) |
| worker 报 401 "身份验证失败" | [§1.2 serve 进程缺 key](#12-serve-进程缺-provider-key401) |
| worker 静默无响应（无 error 无 message） | [§1.3 Kimi 白名单](#13-kimi-白名单静默拒绝) |
| `run_continue` 拒 `no_provider_session`（Kimi/Codex continuable 父 run） | [§1.7](#17-run_continue-返回-no_provider_sessionkimicodex-continuable-父-run) |
| run 无声悬置、转录停在派发+1h（短命宿主派发形态） | [§4.5](#45-run-无声悬置后被宿主-3600s-收尸短命宿主派发形态) |
| 长文档/大文件写入期间摘要不变，分不清在推进还是卡死 | [§6.8 双维度判读](#68-长文档大文件写入期间摘要不变分不清在推进还是卡死) |
| zcode（glm）运行很久不结束，或被判 `turn stalled`——控制面什么时候会自动收口 | [§6.9](#69-zcode-运行什么时候会被控制面自动收口生命体征口径决定-0067) |
| 进程起来不久就退出，worker 一件事都没做（启动期退出） | [§7.15](#715-启动期退出进程起来不久就退出worker-一件事都没做td-180) |
| opencode TUI 能用但 WAO 不能 | [§1.2](#12-serve-进程缺-provider-key401) 或 [§1.3](#13-kimi-白名单静默拒绝) |
| 多行 prompt 被截断（只传第一行） | [§2 CLI 与 shell](#2-cli-与-shell) |
| worker 在错误的仓库目录干活 | [§3 工作目录](#3-工作目录cwd) |
| 终态 spawn_error：报 node.exe ENOENT 但 node.exe 存在 | [§3.2 cwd 目录不存在](#32-run-终态-spawn_error报错说-nodeexe-enoent-但-nodeexe-明明存在) |
| runs 状态池有大量 running 噪音 | [§4 运行数据运维](#4-运行数据运维) |
| run 完成了但 metrics 全 0 | [§5 证据完整性](#5-证据完整性) |
| worker 完成判定不可靠（过早 completed 或该完成没完成） | [§6 完成判定](#6-完成判定) |
| claude-code wrapper 401 / worker 连不上 provider | [§7.1](#71-claude-code-wrapper-401worker-连不上-provider) |
| worker 在错误项目目录干活 | [§7.4](#74-worker-在错误目录干活) |
| agents.json 配置过时/缺 tokenBudget | [§7.5](#75-agentsjson-配置漂移) |
| claude-code worker 看不到用户级 skills | [§7.13](#713-claude-code-worker-看不到用户级-skills临时-claude_config_dir) |
| 不确定环境是否就绪 | [§7.6 wao doctor](#76-wao-doctor-体检) |
| run completed 但 messages 空 / 无 assistant text | [§7.7 证据链断链](#77-worker-输出证据为空但-run-completed证据链断链高危) |
| 认证判 draft-only/rejected 但模型应该会 | [§7.8 认证误判](#78-认证判-draft-onlyrejected-但模型其实会认证误判) |
| 改了 example 配置但 worker 行为没变 | [§7.9 agents.json 真相源](#79-agentsjson-vs-agentsexamplejson-混淆配置真相源) |
| `run_delivery` 返回失败面 / 不知道下一步用哪个交付工具 | [§delivery 失败模式 → 正确工具（闭集查表）](#delivery-失败模式--正确工具闭集查表) |
| `npm test` exit 1 但失败全为 isolation_pass（波内红、隔离绿 ⇒ 原因未明） | [§8.1](#81-npm-test-exit-1-但失败全为-isolation_pass波内红隔离绿--原因未明) |
| `npm test` stderr 打 another full suite WARNING / 同机另一全量在跑 | [§8.1](#81-npm-test-exit-1-但失败全为-isolation_pass波内红隔离绿--原因未明) |
| 交付验证报 `command_timeout` 但单独复跑很快（原因未明，处置见 §8.1） | [§8.1](#81-npm-test-exit-1-但失败全为-isolation_pass波内红隔离绿--原因未明) |
| 验证在排队等待 / 想查同机验证闸持有者或残留租约 | [§8.1](#81-npm-test-exit-1-但失败全为-isolation_pass波内红隔离绿--原因未明)（`runs gate` 只读查询） |
| 主仓根全量尾部 runs-guard RED（套件期间出现新 runs/ 条目） | [§8.2](#82-主仓根跑全量前确认无活跃-workerdaemonruns-guard-红灯td-134) |
| `npm test` 某波长时间不动 / 尾部 `watchdog backstop fired` 或 crashReason=watchdog_timeout | [§8.3](#83-npm-test-波次挂死或长滞看门狗分诊) |

## delivery 失败模式 → 正确工具（闭集查表）

> 行为合同权威在 `docs/usage/delivery.md`（`run_delivery`、候选面 candidateInventory、`run_delivery_reverify` 各节）；本表是"现象→动作"runbook，表中枚举值由 docs-consistency 关系型守卫与代码闭集双向对账。
>
> 跨切规则：任何 readiness 结果只要带 `candidateInventory`/`candidateKind`，先走候选路径（读 inventory → Lead 裁定 → `run_delivery_repackage` 结算），不按 readiness 标签直接人工核或重读。

| 观察到的失败形状 | 正确动作 |
|---|---|
| readiness `not_requested`（`deliveryAvailable:false` + `deliveryRequested:false`） | 正常（非 delivery run），无需动作 |
| readiness `waiting_for_packaging`（非终态请求中） | 带 `waitMs` 重读（`run_delivery` / `runs delivery --wait-ms`）；不要 stop |
| readiness `waiting_for_verification` | 带 `waitMs` 重读；验证是控制面异步事实。例外：若该 run 已 completed 且已有合法 pending 拒绝决策，readiness 会落为 `reviewable`（verification 仍显示 `pending`，acceptance=rejected）——此时无需动作；这是有界结算形态，不是卡死 |
| completed + verification `pending` 无 outcome、无决策（readiness `waiting_for_verification` 一直不落） | 有界 pending 拒绝：`runs delivery <runId> --reject --reason-file FILE` 显式结算（要求 created ref 显式声明 `verification:"pending"`；legacy 缺失状态不具资格，非 completed 也不具资格）。不 stop/reverify/repackage；结算后 readiness 落为 `reviewable`（verification 仍 `pending`）；迟到的真实 outcome 之后照常显示而 acceptance 恒 rejected。规范见 `docs/02-architecture.md` §4.9 |
| readiness `isolation_failed`（`isolationFailure.code` 为 `workdir_escape`） | 无任何 salvage 面：不 repackage/reverify/review/decide/stop——重新派发 |
| readiness `packaging_failed` 且 `deliveryFailure.code` 为 `disallowed_path`（candidateKind `disallowed_scope`，带 candidateInventory） | 读 candidateInventory，Lead 裁定后 `run_delivery_repackage` |
| readiness `packaging_failed` 且 code 非 `disallowed_path`（其余包装失败码） | 无候选面：读 `deliveryFailure.code` + `run_diagnose`（只给事实），重新派发或人工核 |
| readiness `ambiguous` 且 candidateKind `backend_failed`（带 candidateInventory） | 候选路径：Lead 裁定后 `run_delivery_repackage` |
| readiness `ambiguous` 无 candidateInventory | fail-closed 折叠：人工核 transcript |
| 非终态 + candidateKind `process_missing`（readiness `waiting_for_packaging`，孤进程已证死） | `run_delivery_repackage`（first-terminal-wins 结算 orphan）——绝不等于语义 accept |
| reviewable + verification failed + reverify 原因 ∈ {`tooling_invalid`/`environment_contaminated`/`dependency_setup_missing`} 且原始失败码 ∈ 资格闭集 {`command_failed`/`command_timeout`/`execution_error`/`setup_failed`/`setup_timeout`/`setup_environment_error`} | `run_delivery_reverify` 一次（同 commit、原始断言不可改、只能追加 setup）；`artifact_mutated`/`artifact_mismatch` 不具资格 |
| reviewable | 逐页 `run_delivery_review`（fileIndex 至 cursor 尽头）→ `run_delivery_decide` |
| Host 传输中断/取消 | 什么都不做：point-in-time 重读；绝不推断 run 已停 |

---

## 1. provider 故障

opencode-serve 是 HTTP 类 backend：worker 的任务由 serve 转发给 provider API。
故障可能发生在三层：provider 认证 / provider 白名单 / provider 模型行为。
关键区别：opencode TUI 正常 ≠ serve 正常——TUI 继承了终端 env + 可能带特殊 header，
serve 后台进程不一定。

### 诊断套路（worker 卡 submitted 时）

```
1. 查 transcript: 经解析链定位（权威：docs/usage/transcript.md）
   - 看最后状态：submitted（卡住）/ running（正常）/ timed_out
   - 看 backendSessionId

2. 直接查 serve 端 session message（绕过 WAO 看原始响应）:
   curl -s "http://127.0.0.1:4298/session/<backendSessionId>/message?limit=50"

3. 看 assistant message 的结构:
   - 有 info.error → provider 报错（§1.1）
   - 有 parts 内容 → 正常回复，WAO 完成判定的问题（§6）
   - 只有 user message，无 assistant message → 静默拒绝（§1.3）
   - assistant message parts 为空 + tokens 全 0 → 见 §1.1/§1.3
```

### 1.1 provider 返回 error（401/欠费/限流）

- **症状**：worker 快速 `done(failed)`，error 含 "provider error [401]" / "身份验证失败" / "quota"
- **根因**：provider API 返回错误，opencode serve 把它包成 `{info:{role:assistant, error:{name, data:{message, statusCode}}}, parts:[]}` 的 message
- **WAO 行为**：两种完成模式都检测 `info.error`——发现即 `done(failed)` 并透传错误，不等超时。`MessageAbortedError` 除外：它是我们 abort 的副作用，不是 provider 错误
- **修复**：按 statusCode 处理——401 查 key（§1.2），quota/限流 等待或换 provider

### 1.2 serve 进程缺 provider key（401）

- **症状**：worker 报 401 身份验证失败，但 opencode TUI 用同一个 provider 正常
- **根因**：opencode.json 用 `{env:ZHIPU_API_KEY}` / `{env:KIMI_API_KEY}` 引用 key。
  serve 进程没继承这些 env 变量 → 发请求时无认证 → 401。
  TUI 从终端继承 env 所以正常；serve 后台进程启动方式不同，env 可能缺失。
- **验证**：
  ```
  # 1. 确认 key 本身有效（直打 provider API）
  curl -s -X POST "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions" \
    -H "Authorization: Bearer <ZHIPU_API_KEY>" -H "Content-Type: application/json" \
    -d '{"model":"glm-5.2","messages":[{"role":"user","content":"OK"}],"max_tokens":5}'
  # 如果直打成功但 serve 401 → serve 缺 key

  # 2. 确认 key 在 User registry
  powershell -Command "[System.Environment]::GetEnvironmentVariable('ZHIPU_API_KEY','User')"
  ```
- **修复**：用 `scripts/serve.ps1` 启动 serve——它从 User registry 读 key 注入 serve 进程。
  不要用裸 `opencode serve`（可能不带 key）。serve.ps1 支持的 key：ZHIPU_API_KEY / KIMI_API_KEY / DEEPSEEK_API_KEY（新增 provider 在脚本 $keyNames 补一行）

### 1.3 Kimi 白名单（静默拒绝）

- **症状**：Kimi worker session 建立成功、prompt 投递成功，但静默无响应——无 assistant message、无 error message、WAO 卡 submitted 超时。opencode TUI 用 Kimi 正常。
- **根因**：Kimi 的 coding endpoint（`api.kimi.com/coding/v1`）做了客户端白名单，只接受认可的 coding agent 客户端。
  opencode.json 通过 `User-Agent: opencode/1.15.4` 伪装 header 过白名单——但这个 header 只挂在 model id `kimi-for-coding` 上（provider 层 + model 层都配了）。
  用其它 model id（`k2p6` / `kimi-k2.7`）没有 header 配置 → Kimi 静默拒绝（连 error 都不返回，WAO 无法靠 message.error 检测）。
- **验证**：
  ```
  # 直打 Kimi API 确认白名单
  curl -s -X POST "https://api.kimi.com/coding/v1/chat/completions" \
    -H "Authorization: Bearer <KIMI_API_KEY>" -H "Content-Type: application/json" \
    -d '{"model":"kimi-for-coding","messages":[{"role":"user","content":"OK"}],"max_tokens":5}'
  # 返回 "access_terminated_error" → 白名单拒绝（直打也不行，需 User-Agent header）
  ```
- **修复**：opencode 通道的 Kimi worker，model id 必须用 `kimi-for-coding`（唯一带 User-Agent header 的）。
  providers.json 不要用 `k2p6`/`kimi-k2.7` 等其它 id。
- **检测边界**：静默拒绝没有 error message，完成判定无法从消息里看到。可选的 silentTimeout 能把等待截短为早失败（§6.6，默认不启用）；未启用时只能靠 waitTimeout 兜底超时。

### 1.4 DeepSeek-v4-flash 无限多轮

- **症状**：DeepSeek worker 回答后继续无限生成确认轮，token 烧到 waitTimeout
- **根因**：模型行为，每轮 emit step-finish 但 `time.completed` 永远不设
- **修复**：给该 worker 配 `completionMode: "first-stable"`（registry 字段，默认 snapshot-stable）。注意 first-stable 的完成判定对多轮工具调用任务有误判风险（§6.2）

### 1.5 kimi-code backend（进程式，阶段 2 新增）

- **是什么**：Kimi via `kimi-code` CLI（进程式 backend），官方支持 Kimi，过白名单无需伪装 header。进程死即会话死，不存在 opencode 的 stop 虚假成功风险。Kimi 车道现状（kimi-web / kimi-code）见 `docs/usage/lanes.md`。
- **配置**：`backend: "kimi-code"`，`cwd` 必填。registry 条目的 `args` 可追加参数，但不要加 `--yolo` 或 `--auto`：`kimi -p` 不能与它们同用，会以 `Cannot combine --prompt with ...` 退出。binary 默认走 PATH 里的 `kimi`。
- **vs opencode Kimi**：kimi-code 更安全——进程式，加 kimi 自带 max_steps_per_turn=100 + agent_task_timeout_s=900。
- **已知局限：token 预算硬闸门对 kimi-code 无效**。kimi stream-json 不含 usage/token 字段，进程式 backend 无 session endpoint 可轮询。给 kimi agent 配 tokenBudget 不会报错但不生效。kimi 的成本控制靠：kimi 自带超时 + WAO `waitTimeout`。这是进程式 backend 的固有限制（claude-code/codex 同样无 session endpoint，但 claude-code 的 result 事件含 usage，kimi 不含）。
- **完成判定**：kimi 无显式 done 事件，靠进程 exit（exit 0 → done(completed)，非 0 → done(failed)），由 ProcessBackend 兜底。注意 exit 0 仅表示传输完成，不等于 worker 产出了可用结果——见 §6.3 末尾的 completed-empty 说明。

### 1.6 派发报 `credential missing: <ENV>`，但变量明明已 setx（TD-144）

- **症状**：派发秒报 typed 错误 `credential missing: OPENROUTER_API_KEY`（registry 条目声明了 `provider.apiKeyEnv`）；转录零写入、零 fork。PowerShell 查 User 作用域明明有值。
- **判读**：凭据解析顺序是 process.env → Windows Current-User registry（`HKCU\Environment`）→ missing，两个源都找不到才报。每次派发现读注册表、无跨次缓存：setx 之后不用重启宿主，下一次派发即生效；解析到的值由控制面注入 worker 子进程 env（值只进子进程 env 与脱敏器，不进 argv/日志/转录）。仍会报 missing 的情形：值只写在 Machine 作用域（解析不读它），或声明的 env 名与实际设置的名字不一致。
- **验证**：
  ```
  # 双作用域查值（以 PowerShell 为准；Git Bash 下 reg query 的 /v 可能被
  # MSYS 路径转换吃掉，造成"假缺失"误诊）
  powershell -Command "[Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY','User')"
  powershell -Command "[Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY','Machine')"
  # 再看即将运行 WAO 的同一 shell 里子进程是否可见：
  node -e "console.log(!!process.env.OPENROUTER_API_KEY)"
  ```
- **修复**：把值写进 User 作用域（或当前进程 env）并核对名字与 registry 声明一致，然后直接重派。只有宿主进程自身直接消费该 env 的场景（不经控制面桥接拉起的进程）才需要重启宿主或写进 shell profile。

### 1.7 `run_continue` 返回 `no_provider_session`（Kimi/Codex continuable 父 run）

- **症状**：对一个 kimi-code/codex 后端的终态 continuable delivery 调 `run_continue`，被 `no_provider_session` 拒绝；或复用 resume 派发在 runner 侧以固定文案拒绝（"recorded only the process placeholder identity (proc_<pid>)"）。
- **根因（按形状分）**：
  - 父 run 转录只有 `proc_<pid>` 占位 `session.created`，没有 `run.provider_session_bound` 绑定事实（早期 Kimi/Codex 父 run）——明确不可续接，不迁移旧数据；
  - 父 run 是新 run 但 runtime 未在 wire 上广告 native id（无绑定事实）——同上不可续接，重新派发新 continuable run；
  - 绑定事实损坏（重复/空/占位值/与原 spawn 身份不一致）——fail-closed 拒绝，绝不回落占位值。
- **验证**：查父转录（经解析链定位）：应恰有一条 `session.created`（`backendSessionId` 形如 `proc_<pid>`）且恰有一条 `run.provider_session_bound`（`providerSessionId` 为 kimi `session.resume_hint` / codex `thread.started` 广告的 native id）。
- **修复/规避**：对旧父 run，让 Lead 以新的 `run_dispatch`（`continuable:true`）重新交付并接手冻结候选；新 run 会记录绑定事实，之后 `run_continue` 即用真实 native id 续接。claude-code 父 run 不受影响（resume 编译 opaque uuid，proc 身份不是阻断）；ACP 的 native `session.created` 照常可续接。

---

## 2. CLI 与 shell

### 2.1 PowerShell 多行 prompt 截断

- **症状**：多行 `--prompt "..."` 只传了第一行
- **根因**：PowerShell 原生参数解析截断多行字符串
- **修复**：多行 prompt 用 `--prompt-file <path>`（从文件读，完整传递）。单行可用 `--prompt`

### 2.2 CLI run 成功但 exit code 1

- **症状**：`npm run cli -- run ...` 返回 WAO_OK（成功），但 shell 显示 exit code 1
- **根因**：待诊断（run completed 但 CLI 退出码非 0，可能是 collect/render 路径的异常被吞）
- **临时绕过**：检查 transcript 确认 run 真实状态，忽略 exit code

### 2.3 scorecard rules 没生效（PowerShell JSON quoting）

- **症状**：`--scorecard-rules '{"requireEvidence":true}'` 传了，但 `runs scorecard` 返回 "no rules"
- **根因**：PowerShell 的单引号字符串行为和 bash 不同——单引号 JSON 可能被 shell 解析吃掉。
  这不是 WAO bug，是 shell quoting 问题。
- **修复（PowerShell）**：双引号 + 转义，或直接从文件读：
  ```powershell
  # 不行（单引号 JSON 被 PowerShell 吃掉）
  --scorecard-rules '{"requireEvidence":true}'
  # 正确（双引号 + 转义）
  --scorecard-rules "{\"requireEvidence\":true}"
  # 更稳妥（从文件读，绕开 shell quoting；与 --scorecard-rules 互斥）
  --scorecard-rules-file rules.json
  ```
- **验证**：transcript 应出现 `scorecard.checked` 事件；`runs scorecard <runId>` 应显示 checks

---

## 3. 工作目录（cwd）

### 3.1 worker 默认 cwd 落在派发进程所在目录，不是目标仓

- **症状**：worker 在 `D:/projects/windows-agent-orchestrator`（或你敲命令时所在的任何目录）干活，而不是你要它改的目标仓库
- **根因**：registry 模板把所有 worker 的 `cwd` 统一为 `.`（`cwd` 字段必填，缺失在 `registry validate` 即报错）。`.` 解析为**发起派发的进程的当前工作目录**——CLI 通道=你敲命令时所在目录；MCP 通道=MCP 服务进程的 cwd，由 host 决定。从 WAO 仓根跑 CLI，worker 就落在 WAO 仓。每个 worker 的 cwd 应指向它要操作的目标仓。
- **边界（须知）**：不传 `--cwd` 时 worker **静默落在派发进程 cwd**——`.` 恒存在，不会早拒绝。各通道差别：
  - 后台 delivery 不受影响：CLI 边界对 `--background` + delivery 强制 `--cwd`，缺失直接抛 `DeliveryCwdRequiredError` 早拒绝。
  - 前台 delivery 不设此门：其 worktree 源仓来自 registry cwd，`.` 时会从操作者当前 shell 所在仓切 worktree——同样必须显式 `--cwd` 指向目标仓。
  - MCP 通道安全：host 绑定 workspace root 为 cwd；resume 同样安全。
  - 受影响的是 CLI 前台/后台/workflow 快起路径——这些路径的用法一律**显式带 `--cwd`**。
- **提示**：`wao doctor` 对 cwd 为 `.` 的 worker 会出一条 INFO 落点提示（advisory，不计 DEGRADED）。
- **修复**：
  - 派发时显式 `--cwd "D:/path/to/target-repo"`
  - 或在 agents.json 里把每个 worker 的 cwd 改成目标仓（必须已存在，否则见 §3.2 的 typed 早拒绝）
  - worktree 隔离时（`--isolate`），cwd 是 worktree 路径，自动正确

### 3.2 run 终态 spawn_error，报错说 node.exe ENOENT 但 node.exe 明明存在

- **症状**：派发/执行终态 `spawn_error`，`run.error` 写着 `spawn C:\...\node.exe ENOENT`，但该 node.exe 实际存在
- **判读**：**报错归咎 node.exe 但 node.exe 存在时，真因几乎总是 cwd 目录不存在**——Node spawn 的经典陷阱：`cwd` 选项指向不存在的目录时，ENOENT 会归咎到可执行文件名上。工作目录来自显式 `--cwd`，否则来自 registry 条目的 `cwd`。
- **现状**：对不存在的 cwd 已双层早拒绝——前台执行通道（RunManager start/resume）与后台派发通道（dispatchRun）都在 transcript 写入/worktree 创建/fork/spawn **之前**，按 backend 能力（`preflightInvocation`；HTTP serve backend 豁免——cwd 是远端提示）预测 `path.resolve` 后非已存在目录（是文件同样算），抛 typed error `DispatchCwdNotFoundError`（reasonCode `dispatch_cwd_not_found`，message 含解析后绝对路径与来源）。新派发不会再走到 spawn 期；本判读保留给**旧 transcript** 与自配 cwd 打错/目录后被删的情形（§3.1）。
- **修复**：`--cwd` 指向已存在的目标目录，或把 agents.json 里该 worker 的 `cwd` 改成真实项目路径。`wao doctor` 对 registry 里不存在的本地进程式 worker cwd 会预先给 WARN。

---

## 4. 运行数据运维

### 4.1 runs 状态池有大量 running 噪音

- **症状**：`runs summary` 显示很多 running，但都是历史遗留的 run（不是当前任务）
- **根因**：旧 run 没清理 + 泄漏 session（session 未被 kill 的 run 永远卡在 running/submitted）
- **修复**：
  - 手动清理：`npm run cli -- runs prune`（支持 `--older-than` 按时限清理、`--archive` 归档），或删除 `runs/` 下的旧 jsonl
  - 杀泄漏 session：`taskkill /IM opencode.exe /F`（会杀所有 serve session，慎用）
- **预防**：run 结束后 WAO 会兜底发送 abort，并在 opencode 类 handle 上做后台 quietness 验证。历史遗留 session 仍需手动清。

### 4.2 旧泄漏的 serve session（quota 风险）

- **症状**：serve 进程里有多个 ESTABLISHED session，对应已结束的 run，仍在烧 token
- **根因**：run 结束时未被 abort 的 serve session 不会被 provider 停止——DeepSeek/GLM 这类模型会一直烧到 quota
- **现状**：`stop` 命令和 RunManager 终态清理路径都接入后台 quietness 验证——abort 后联合观察 OpenCode session status 与 token/message 稳定性。观察面不可读会诚实记录 unverified；确认仍 active 时告警，但不会自动全局 taskkill 其他 session。**仍务必给每个 opencode agent 配 `tokenBudget`**——这是不依赖 abort 生效的最后一道防线。
- **修复**：`taskkill /IM opencode.exe /F` 杀 serve（连带所有 session），用 serve.ps1 重启
- **诊断**：`netstat -ano | findstr :4298 | findstr ESTABLISHED` 看 session 数

### 4.3 run_await_result 返回 read_failure（transcript 读失败）

- **症状**：`run_await_result` 返回 `observationOutcome=read_failure`，`result.status=unavailable`
- **机器协议**：同时携带闭集 `readFailureReason`，Lead 可直接按码决策，不需要读错误原文：
  - `transcript_parse_failed` — transcript 读取/JSON 解析异常（文件缺失、不可读、某行 JSON 损坏）
  - `legacy_event_shape` — 快照含 JSON 合法但不可用的历史条目（null / 原始值 / 数组），或快照不是数组
  - `snapshot_unavailable` — 其他安全的非解析类失败（如残留投影派生失败）
- **根因**：transcript 文件损坏或被截断写入（进程被杀、磁盘满、跨进程并发写同一 jsonl）
- **修复**：检查转录完整性（经解析链定位）；`transcript_parse_failed` 多为写入中断，`legacy_event_shape` 多为旧格式历史数据。控制面**绝不泄漏**错误 message/path/command/credential——字段只有闭集码，成功路径（observed）为 `null`
- **注意**：unexpected 内部异常仍是固定 opaque 错误（`run_await_result failed`），不会变成 success 形状

---

### 4.4 worker 中途死亡，worktree 半成品抢救（手工配方）

worker 死于隔离守卫（workdir_escape）或供应商断流时，其 worktree 可能留有有价值 WIP。**先分两类**：

- **delivery run，候选通道可用**：走既有候选通道（`runs delivery` 读 candidateInventory/candidateKind：backend_failed / process_missing / disallowed_scope → Lead 裁定后重打包）。
- **delivery run，但 `candidateKind:null`**：只有同时满足以下前提才可用本手工配方：`run_delivery` 已确认没有可重打包的候选；retained worktree 仍存在且绑定该 run/workspace/base；Lead 逐文件核对 worktree 候选、允许路径与验证结果；采纳提交不得夹带候选以外内容，并记录 `WAO-Adopted-From` / `WAO-Original-Delivery: (none)` / `WAO-Adoption-Basis`。这是控制面外的人工恢复，不把 `null` 解释成已证明安全，也不冒充 `run_delivery_repackage`。
- **非 delivery run**：同样可用本手工配方。§快速索引表"workdir_escape 无 salvage 面"说的是**控制面工具**（不 repackage/review/decide）——手工抢救在控制面之外，两者不矛盾。

```bash
# 1. 定位 worktree（.wao-worktrees/<runId>；或读转录 delivery 事件的 worktreePath（经链定位）
# 2. 导出补丁（含 untracked：先 add -N 再 diff）
git -C <worktreeRoot> add -A -N
git -C <worktreeRoot> diff > "%TEMP%\\<runId>-wip.patch"
# 3. Lead 评估补丁后按采纳协议处理（如合入：commit 带 WAO-Adopted-From: <runId> trailer——见 docs/usage/delivery.md 验证失败采纳协议）
# 4. 清理：npm run cli -- worktree remove <worktreeRoot>（内部即强制清理并重试）
```

边界：本配方是**人工采纳**，不自动接受任何 WIP；价值判断完全归 Lead。**归档/清理历史 runs 前的固定步骤 = 确认无可抢救 WIP**。

### 4.5 run 无声悬置后被宿主 +3600s 收尸（短命宿主派发形态）

- **症状**：从**短命宿主会话**（headless `zcode -p`、一次性脚本）经插件 MCP 派发后，run
  停在早期事件零进展；转录 mtime 恰好停在**派发+3600s**；无 run.error、无 .owner 心跳
  （spawn 前挂死形态）或心跳活到收尸一刻（spawn 后挂死形态）。
- **已知事实**：宿主清理域对后代进程是**延迟收割**（观察值 1 小时）——早退会话不是
  即杀，而是约一小时后清理整棵进程树。挂死本身根因未明（受控复现未再现）；+3600s
  收割者身份未定位。
- **运维处置**：短命会话用"单会话大回合"保活（dispatch → run_await_result → 需要时
  run_continue → collect，sleep 桥保活到终态）；CLI 后台派发的 detached runner 不受
  shell 退出影响。诊断顺序：先看 .owner 心跳（活心跳+零转录进展=spawn 前挂死；无
  心跳+转录残缺=同形态）再查转录 mtime 与派发时刻差。
- **边界**：观察登记；不引入 broker/看门狗（会审裁定）。

## 5. 证据完整性

### 5.1 metrics 提取（已修复）

- **症状**：run 成功 completed，但 `run.metrics` 记 `tokens:{input:0,output:0}`，实际 provider 用了几万 token
- **根因**：message.info.tokens 在流式传输期间是 0（serve 在 message 完成后才回填）——读到的是流式占位值
- **现状**：metrics 从 **session endpoint**（`GET /session/{id}`）提取累计 tokens——serve 维护的累计值，比 message.info.tokens 可靠；run 进行中也周期性提取，tokenBudget 闸门不必等完成即可触发
- **验证**：transcript 的 metrics 事件与 `runs metrics` 应显示非零累计 token

---

## 6. 完成判定

WAO 的完成判定有两种模式：`snapshot-stable`（默认）和 `first-stable`（配 `completionMode`）。

### 6.1 snapshot-stable 对慢响应 + 短 timeout 误判超时

- **症状**：worker 实际回复了，但 run 还是 timed_out
- **根因**：snapshot-stable 需要两轮稳定（看到 assistant → 等 interval → 快照不变 → done）。
  如果 waitTimeout < (响应时间 + 2×interval)，第二轮确认来不及就超时
- **修复**：对慢响应模型（GLM 首次冷启动 ~30s），waitTimeout 设为响应时间的 2-3 倍。或用 first-stable（快，但有 §6.2 风险）

### 6.2 first-stable 完成判定（C' 重设计，已修复）

- **判据**：first-stable 以"**首条含非空 text part 的 assistant message**"为完成信号。
  text part 精确区分"还在干活（工具轮，有 tool 无 text）"和"给出答案（text 出现）"。
  完成后 emit 首条 assistant 并立即 abort serve 端 session，不等后续重复轮。
- **为什么不看 step-finish**：DeepSeek 每轮（含工具轮）都 emit step-finish——把它当完成
  信号会在工具轮截断多轮任务。
- **取舍**：首条 text 即完成——任务需要模型多轮正文时会被提前截断。适用于回答后无限
  重复确认轮的模型（DeepSeek-v4-flash 等，在 registry 条目里配 `completionMode: "first-stable"`；缺省
  是 `snapshot-stable`）。

### 6.3 ProcessBackend（claude-code/codex）exit 1 → done(failed)（已实现）

- **退出码兜底**：进程式 backend 流结束时若无显式 done 事件，按进程 exit code 收口：
  0 → `done(completed)`，非 0 → `done(failed)`（`run.error` 如
  `"process exited with code 1"`，state=failed）。
- **metrics 缺失（不可避免）**：claude 进程在打印最终 `type:"result"`（含 token usage）
  **之前**崩溃 → result 事件从未产生 → metrics 无法提取。这不是 WAO bug，是进程崩溃的
  固有后果（数据源没产生）。
- **exit 0 ≠ 有用结果（completed-empty）**：进程 exit 0 → `done(completed)` 仅是**传输完成**，
  不是 worker 产出可用结果的证据。一个 completed run 若只有 transport 活动（runtime
  initialized/streaming、thinking、zero-usage metrics）而**没有任何可用产出**（assistant
  文本、命令活动、文件写入、tool_use/tool_result），不再被当成一次正常完成：诊断归类
  `no_effect` + 事实码 `completed_empty`（`src/diagnosis.js` 的 `NO_EFFECT_DIAGNOSIS_CODES`），
  主控据此不会把空转 worker 误判为有效 review/delivery。MCP `run_diagnose`/
  `run_await_result` 把 `category=no_effect` 与 `code=completed_empty` **同时**透出到 wire
  （`code` 闭集为单一通用 `DIAGNOSIS_CODES` SSOT，经 `isValidDiagnosisCode(category, code)`
  配对校验；**failed** 的 `no_effect` run 仍 `code=null`，正常 completed 仍 `none/null`）；
  ProcessBackend 也在流边界对"成功但无可用产出"的完成直接打 `completed_empty` 机器事实
  （parser `done(completed)` 与 exit-0 兜底两条路径同时生效）。有效的 tool-only /
  command-only / file-written 完成仍判 `none`。

### 6.4 worker 失败时主控收不到证据（已修复）

- **现状**：CLI 的 `runAndWait(run, options)` 包装 `waitForCompletion`，捕获 failed 抛错，
  转为结构化结果：
  ```json
  {"runId":"run_xxx","completed":false,"failed":true,"timedOut":false,"error":"provider error [401]: 身份验证失败","transcript":"<path>","diagnosis":{...}}
  ```
  error 超长会截断（500 字符）并指向 transcript；`run`/`spawn --wait`/并行 wait 三个路径
  都已接入。主控能看到 runId（定位 run）+ error（决定是否接手）。
- **主控接手决策**：收到 `failed:true` 后：读转录（经解析链定位）看详细证据 → 判断失败
  原因（可恢复/不可恢复）→ 决定重试、换 worker、或自己接手。

### 6.5 snapshot-stable 伪完成（codex 实测暴露，已修复）

- **判据**：snapshot-stable 的 completed 判定要求"快照稳定 + **至少一条 assistant message
  有非空 text part**"——GLM 在 tool-call 轮的 message 有 tool part（非 step-start）但无
  text（读完文件没答），只看快照稳定会把它判成 completed（`assistantTextCount=0` 的伪
  完成）。无 text 则重置观察状态继续等，不判 completed（与 first-stable C' 对齐）。
- **纵深防御**：scorecard 的 `requireAssistantText` 规则——即使完成判定漏了，scorecard
  也会拦截"completed 但无 assistant text"。

### 6.6 静默无响应早失败（silentTimeout，已实现）

- **症状**：Kimi 白名单 / 不存在的 model：serve 不产 error message 也不产 assistant message
  → 只能等完整 waitTimeout
- **现状**：两个完成模式都支持 `silentTimeout`——超过该时长仍无 assistant message 无
  error → `done(failed)`（"silent timeout"）。默认不启用；启用需在 streamEvents 调用时传
  silentTimeout（ms）

### 6.7 first-stable metrics 偏小（codex 实测暴露，已修复）

- **症状**：first-stable 的 CLI metrics `input:408`，但 serve session 实际 `input:29706`
- **根因**：按首条 message 的 `info.tokens` 瞬时值提取，不是累计值——多轮工具调用的真实
  消耗远大于首条
- **现状**：first-stable 完成后先 abort serve session，再重试读 session endpoint、等累计
  usage 稳定（serve 在 abort 后可能延迟一小段时间才回填，单次读会出现假 0），取累计
  metrics；读不到回退 message.info.tokens

### 6.8 长文档/大文件写入期间摘要不变，分不清"在推进"还是"卡死"

- **症状**：worker 长时间写同一文件时，状态摘要停留在同一文件名；长静默 CPU 段零新事件，
  无法区分"在算"与"断了"。
- **判读（两个维度，配合用）**：
  - **推进维度**：CLI `status <runId>` 的 `lastActivitySummary` 对重复同名写带计数——
    `写 report.md ×3（最近）`（file_written 子序列尾部同名计数；CLI 独有，MCP `run_status`
    有意不返回该摘要）。
  - **时间维度**：CLI `secondsSinceActivity` / MCP `run_status` 的 `lastActivity.secondsSince`
    （同一事实的两种字段名）——即"当前活动已持续 X 秒"，**不要等摘要变化**；静默超过阈值
    再结合 heartbeat 判停（判停永远 Lead 决定）。
- **边界**：计数饱和（交错写入下有效上限远低于扫描上限）不影响判读——×20 与 ×30 都是
  "在推进"；"卡死"判定归时间维度。

### 6.9 zcode 运行什么时候会被控制面自动收口（生命体征口径，决定 0067）

- **口径**：控制面只在运行**完全没有生命体征**时自动收口；只要有生命体征就继续等，
  放弃与否由 Lead 决定，WAO 只提供事实与建议。
- **收口门（三道"等不到进展"的门，到点时先看生命体征）**：零 part 阶段的 silentTimeout
  （配置了就以它为界）与 120 拍思考预算（silentTimeout 缺席时的兜底）；已有产出后的停滞
  预算（300–600s 自适应：`min(600s, max(300s, 3×本轮已恢复的最大静默间隙))`）。
- **算生命体征的**（任一成立即不收口）：
  - **进度**：快照里落了新 part，或既有工具调用落了新证据（开始 / 结束）。
  - **模型流在收**：最近 60s 内收到过流分片。长思考期间转录里每分钟一条
    `runtime_activity`（status `streaming`），`run_wait` 显示 `liveness=progress`、
    `lastActivityKind=runtime_status`。
  - **工具子进程在干活**：宿主进程的后代进程在 30s 观察窗内 CPU ≥20 ms/s，或 I/O ≥64 KB/s，
    或有进程新生 / 退出（测试、构建、后台任务属此类）。
  - **工作目录里有文件变化**：同一观察窗内，已改动 / 未跟踪（未被忽略）文件的清单、
    mtime 或大小变了。

  凭后两项续命时转录各落一条 `runtime_activity`（`process_active` / `files_changed`，
  每种至多每分钟一条）。
- **不算的**：工具挂着但不耗 CPU 也不写文件（`sleep`、等远端且无流量）、流断了且没有
  子进程在动。观察窗比对得出"没有活动"后再多看一拍，仍无进展才收口；错误文案写明取到
  的读数（`no model stream chunk…` / `no process activity in the last 30s (cpu +…ms, io +…B
  across N descendant process(es))` / `no file change in the working tree`），停滞门以
  `no vital signs, bounded exit` 结尾，零 part 两道门在原文案后附 `— no vital signs: …`。
  进程快照瞬时失败会在下一拍重取，连续三次失败按取不到处理；非 Windows 且非 git 目录时
  两项都不适用，立即收口。
- **"没有自动上限"只指这三道门**：有生命体征的运行不会因"等不到进展"被收掉——没人看着
  它，就会一直跑到自己结束或生命体征消失，期间占着工作树。协议错误、传输关闭、快照缩短、
  历史变异等"证据不可信"的失败照旧立即收口。
- **证词会看错**：与任务无关的插件进程在耗 CPU、反复崩溃重启的 helper、别人在同一个未
  隔离的工作目录里写文件，都会让一个其实没在推进的运行一直"活着"；被 `.gitignore` 排除
  的写入、宿主进程内部的工作、低 CPU 的等待，则读不出活动。所以去留要 Lead 自己看。
- **Lead 怎么判断去留**：CLI `status <runId>` 在未终态且转录里 ≥30 分钟没有新的动作或正文
  时附 `advisory` 一行（多久没有、最近活动是什么、中止命令）——它陈述的是转录可见的事
  实，zcode 的正文到轮末才落转录；MCP 面 `run_status` 带同一事实的 `leadAdvisory`，
  `run_wait` 带注记 `observation.transcript_quiet`。
- **中止**（先看最新状态并写明理由，见 usage）：`stop` / MCP `run_stop`——会话记录带
  `hostPid` 的运行走进程树击杀并核验；resume 重放过的运行，目标是重放记录的新进程。会话
  记录里没有 `hostPid` 的运行报 `has no stop route`：核实其 app-server 进程后手动结束进程
  树，转录会以 `transport closed` 落 failed。
- **诚实边界**：流分片是上游内部遥测，只在 zcode CLI 0.16.9 上验证过；进程活跃度阈值
  （空闲 CPU 0–2.5 ms/s、I/O 4–9 KB/s）来自一次真机探针，不是长期统计。读数与来由见
  决定 0067。

---

## 7. 进程式 backend + 部署（claude-code/kimi-code/codex）

进程式 backend 是主力路径。本章覆盖进程式路径的坑与实机部署问题。

### 7.1 claude-code wrapper 401（worker 连不上 provider）

- **症状**：走 claude-code provider wrapper 的车道（模板里没有这种车道，自建时才会遇到）报 `401 Invalid authentication credentials` / `身份验证失败`
- **根因 A：provider key 没进 Lead runtime env**。wrapper 用 `ANTHROPIC_AUTH_TOKEN` 注入认证，它读的是 `process.env.<KEY_ENV>`（如 ZHIPU_API_KEY）。如果 Lead runtime 进程没继承这个 env（key 在 User registry 但没进 runtime 的 env），wrapper 拿不到 key → 401。
- **根因 B：claude-code OAuth 登录态覆盖 provider key**。当 `~/.claude/.credentials.json` 含 `claudeAiOauth` 时，claude-code 可能优先用 OAuth accessToken，忽略 wrapper 注入的 `ANTHROPIC_AUTH_TOKEN`，把 Claude OAuth token 发到 DeepSeek/ZHIPU base URL → 401。wrapper 给 provider worker 设置独立的 `CLAUDE_CONFIG_DIR`（`.wao-worker-claude-config/`），隔离用户 `~/.claude`，provider worker 读不到 Claude OAuth 凭证；`opus` 车道不走 wrapper，使用官方 Claude OAuth。
- **验证**：`npm run cli -- wao doctor` 会查 key 是否在 env。或手动 `echo $ZHIPU_API_KEY`。若 key 存在但 provider worker 仍 401，检查 transcript 的 provider error；OAuth 覆盖类问题通常表现为 token tail 与 provider key tail 不一致。
- **修复**：确保 key 在 User registry（`[System.Environment]::SetEnvironmentVariable('ZHIPU_API_KEY','<val>','User')`），重启 runtime 让它继承。不要把 `~/.claude/.credentials.json` 复制到 `.wao-worker-claude-config/`。

### 7.2 DeepSeek variant=max 不能用 model 后缀

<!-- model-specific -->
- **症状**：`--model deepseek-v4-flash:max` 报 `400 The supported API model names are deepseek-v4-pro or deepseek-v4-flash`
- **根因**：DeepSeek anthropic 端点只认 `deepseek-v4-flash` / `deepseek-v4-pro`，variant 不是 model id 的一部分
<!-- /model-specific -->
- **修复**：variant=max 用 `--effort max`（映射到 `CLAUDE_CODE_EFFORT_LEVEL` env），**不要**塞进 model id

### 7.3 opus 车道（claude-code 官方通道）401

- **症状**：`opus` 车道的运行报 401
- **根因**：`opus` 车道用官方 Claude（不走 wrapper），需要 claude-code 自己的认证（`claude login` 或 API key），不是 provider key
- **修复**：`claude login` 完成官方认证

### 7.4 worker 在错误目录干活

- **症状**：worker 在 WAO 工具仓或错误项目干活，不在目标项目
- **根因**：派发时没带 `--cwd <目标项目>`，worker 用了 agents.json 的默认 cwd `.`——它解析为**发起派发的进程的当前工作目录**（CLI 通道=你敲命令时所在目录，MCP 通道=MCP 服务进程的 cwd，由 host 决定），不是目标项目（trade-off 详见 §3.1）
- **修复**：要在目标项目干活就派发时带 `--cwd <目标项目>`（快起路径的最佳实践）；或把 agents.json 里该 worker 的 `cwd` 固定为目标项目路径（必须已存在，见 §3.2）。后台 delivery 不受影响——CLI 边界对 `--background` + delivery 强制 `--cwd`，缺失直接早拒绝；前台 delivery 不设此门，同样要显式带 `--cwd`（worktree 源仓来自 registry cwd）

### 7.5 agents.json 配置漂移

- **症状**：worker 用了过时的配置（旧 worker 名、缺 tokenBudget、backend 不认）
- **根因**：agents.json 没跟上入库模板 `config/agents.example.json`，或沿用了旧版配置
- **验证**：`npm run cli -- registry validate --registry config/agents.json` 检查所有 worker。opencode worker 必须有 tokenBudget
- **修复**：对照 `config/agents.example.json` 更新 agents.json，重跑 registry validate

### 7.6 wao doctor 体检

- **何时跑**：部署前、出问题时第一件事、定期
- **命令**：`npm run cli -- wao doctor [--registry config/agents.json] [--cwd <目标项目>] [--format json] [--strict] [--warn-as-error]`；`--warn-as-error` 只把 WARN 也卡成非零退出（CI 用），不改报告内容；`--strict` 加跑 src/ 的 JS parse smoke
- **检查项**（scoped——只按 registry 保留 worker 收窄；逐项语义以 doctor 输出与 src/commands/doctor.js 为权威，此处只列要点）：
  - Node 版本（>=22）；保留 worker 的 CLI 在 PATH（无 worker 需要 CLI 时 INFO 跳过）；声明的 provider key（进程 env 或 Windows User 作用域；kimi-code 走 CLI 登录态）；agents.json 完整性（opencode worker 必须配 tokenBudget）；registry `cwd` 存在性（`path.resolve` 后须为已存在目录；`.` 解析为派发进程 cwd 恒存在不误报，语义详见 §3.1/§7.4；sessionReuse worker 的 WARN 措辞区分实际先发拒因）；承重 env 存在性（按 spawn 解析序 agent.env → 进程 env → User 作用域检查；file 类查路径存在，缺失即 FAIL——该 backend spawn 期会死）；claude OAuth 临时目录报数（doctor 只报数不删除，清理见 §7.14）；claude OAuth 认证模式（长期令牌 / 凭据拷贝，见 §7.14）。HTTP serve backend 的 cwd 是远端目录提示，不检查。环境类检查落 doctor 而非 `registry validate`（后者纯静态 schema）。
  - 目标项目的 `.wao/` 是否 init（未 init / fresh clone 缺槽位是 WARN，结构混乱才是 FAIL）
- **判读**（advisory，非门禁——doctor 不自动阻断任何派发，verdict 行自带"（advisory，非门禁）"标注）：
  - `HEALTHY`：无 FAIL 无 WARN，可直接继续
  - `DEGRADED（N warn）`：仅 WARN（如 User 作用域 key 未继承、.wao 未 init），可直接继续
  - `BROKEN（N fail[, M warn]）`：有 FAIL——按每条 FAIL 的 `run:` 提示处理（装 CLI / `setx` 配 key / `wao init`），处理后由你（Lead/owner）裁定是否继续

### 7.7 worker 输出/证据为空但 run "completed"（证据链断链，高危）

- **症状**：run `completed=true` 有 metrics，但 `messages` 空 / `assistantTextCount=0` / 命令证据缺失 → 认证 draft-only/rejected，或真实任务 Lead 收不到 worker 回复
- **第一反应（纪律）**：**别先怀疑模型能力**。"completed 但空"几乎总是**证据提取断链**，不是模型没做。先抓原始 stream-json 看模型到底输出了什么，再判断
- **现状（parser 行为）**：claudeCode parser 按 message id + content 签名去重——claude-code 对同一 message 的 thinking 块和 text 块分两条 stream-json 行发出、共享同一 id，只按 id 去重会误杀 text 行，因此只有字面完全相同的重发行才被跳过。命令工具识别闭集 Bash/PowerShell/Cmd（Windows 上 claude-code 暴露 PowerShell/Cmd），都产出 command 事件
- **验证**：直接跑 `claude -p "..." --output-format stream-json` 抓原始输出，对比 transcript——若原始有但 transcript 没，就是 parser 没捕获
- **教训（决策 0009）**：观测异常（空输出）+ 领域常识（LLM 当然会回复/跑命令）矛盾时，**先查证据链再下结论**

### 7.8 认证判 draft-only/rejected 但模型其实会（认证误判）

- **症状**：`npm run reliability` 报 worker `draft-only`/`rejected`，看起来"模型不会跑命令/不会写文件"
- **第一反应（纪律）**：**别接受异常结果**。当前主流 LLM 都会跑命令+写文件。draft-only 多半是证据没捕获（见 §7.7），不是能力缺失
- **典型根因**：parser 漏认 Windows 命令工具（§7.7）→ commandsPassed 永远失败 → 看似"不会跑命令"
- **验证**：抓认证 drill 的原始 stream-json，确认模型是否真的发了 tool_use（Bash/PowerShell）。发了但 commandsPassed=false = parser bug，不是模型问题
- **修复**：升级 WAO（parser 现已识别三类命令工具）

### 7.9 agents.json vs agents.example.json 混淆（配置真相源）

- **症状**：改了 `agents.example.json` 但 worker 行为没变；或认证报 worker 不存在
- **根因**：runtime/reliability 套件读的是 `config/agents.json`（**gitignored，本机实际生效**），不是 `agents.example.json`（提交的模板）。两者可能不同步——example 是权威模板，agents.json 是落地实例
- **验证**：`node -e "console.log(Object.keys(require('./config/agents.json').agents))"` 看实际 worker 名
- **修复**：以 `docs/team-roles.md` 为权威，**两个文件都同步**。改 example 后复制到 agents.json（反之亦然）

### 7.10 backend 最后失败，但 retained worktree 里已有候选改动

- **症状**：delivery run 因 `backend_error` 或 `backend_stream_ended` 终态失败，没有 DeliveryRef；但 worker 在隔离 worktree 已写入文件。
- **先查事实**：调用 `run_delivery`。只有返回 `candidateKind:"backend_failed"` 且 `candidateInventory` 完整非空，才表示 WAO 已证明 runtime quiet、exact base、workspace ownership 和候选清单；`candidateKind:null` 不是"无成果"，也不是已证明可采纳。若 retained worktree 仍有候选，只能按 §4.4 的 delivery-run 前提走控制面外人工采纳，并逐项留下绑定、范围、验证和无夹带证据。
- **恢复**：Lead 审查 inventory 后明确提供完整 `allowedPaths`，调用 `run_delivery_repackage`。它不调用模型、不恢复 provider session，只在原 worktree 机械重算范围、打包并运行原验证声明。
- **裁决**：重封装后仍逐文件审查，并由 Lead 单独 accept/reject。WAO 不判断候选语义、不自动扩域、不自动重试；缺 `run.stop_verified`、HEAD 漂移、冲突事件、空/截断 inventory 均不提供该恢复路径。

### 7.11 Claude Code 新版 partial stream / retry 状态与 cache token

- **现状**：Claude backend 启用 `--include-partial-messages`；init/streaming/provider retry 只投影成 payload-free 闭集 `runtime_activity`；stream delta 按固定间隔采样，原始文本/error/session/model 不落 transcript。cache read/write 使用独立指标字段，不混入 reasoning。
- **隔离**：WAO Claude worker 设置 `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`；delivery mode 额外设置 `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`。普通一次性 run 使用 `--no-session-persistence`，显式 session reuse 不使用该 flag。
- **验收边界**：本地 parser/wrapper/argv/env 与 synthetic stream 可 no-model 验证；官方 Claude/真实 provider 行为仍需具备对应订阅或 credential 后单独 canary，不得用本地测试冒充真实 runtime 验收。

### 7.12 DeepSeek Harness JSON-RPC backend 启动或空结果

- **先确认边界**：WAO 只 detect/invoke/report，不安装、升级、登录或修复 DSH。GUI 中选择的 preset 不会自动成为 WAO worker；WAO 使用 registry 明确指定的 dedicated `dsh-jsonrpc-agent` + Cordis config。
- **preflight 报配置错误**：确认 `binary` 可执行、`dshConfigPath` 可读、`credentialEnv` 为非空环境变量名；用 `registry validate` 检查静态合同，用 `registry list` 检查 credential availability。
- **runtime identity mismatch / malformed JSON-RPC / transport closed**：这是 DSH composition 或 transport 故障，不是模型语义失败。直接运行同一 binary 做 `initialize` no-model probe；不得改成抓 TUI 文本或把未知输出投影为 completed。
- **内部 subagent 事件导致失败**：这是预期 containment。WAO 的 worker 不能再通过 DSH 内部编排绕过 Lead/WAO；关闭 composition 中的 subagent/workflow 后再派发。
- **认证显示 null**：认证按 agent id + backend + model 绑定。把同名 worker 从 claude-code 切到 DSH 后，旧认证不会继承；先做真实 canary，再由 Owner 决定是否运行完整 reliability。

### 7.13 claude-code worker 看不到用户级 skills（临时 CLAUDE_CONFIG_DIR）

- **症状**：用户日常 `~/.claude` 的技能/插件/设置对 WAO 派发的 claude-code worker 不可见；反向同理。
- **根因**：native OAuth 通道 worker 运行于 `%TEMP%\wao-claude-oauth-*` 临时隔离目录——拷贝模式只含凭据副本、令牌模式全空（§7.14），其余全空是设计行为（实现与动机见 src/backends/claudeCode.js 头注释）。
- **逃生门**：确需时往该 lane 注册表 `args` 加 `--add-dir <最窄目录>`（勿给整个主目录）。给的是**文件读取面**——不注册为 Skill 工具可调用技能。args 指纹与 addDirs 随 run.started 留痕；改动按 lane 变更走 drift 检查。

### 7.14 claude-code native OAuth 被反复登出（凭据拷贝 × 续期轮换互斥）

- **症状**：native 车道启动即 `OAuth session expired and could not be refreshed`，重新登录只管几小时；`~/.claude/.credentials.json` 周期性被清空。
- **根因**：CLI 在副本内续期后，新 refresh token 只落副本随目录销毁，原件留下已作废旧令牌——下次拷贝续期失败、CLI 清空登录。
- **修复**：`CLAUDE_CODE_OAUTH_TOKEN` 可解析（进程 env 或 Windows 用户环境，无需重启服务器）时目录保持空、不拷贝凭据、认证走 env（CLI 2.1.289 实测空配置目录认此变量）。缺席回退旧拷贝路径（轮换缺陷仍在）。空值视为缺席（若 CLI 把空串当已设置是可见 401，非静默毁登录）。token 值不进 argv/转录（名字经 inheritedNames 进脱敏器）。
- **迁移（Owner 一次性）**：`claude setup-token` 生成长期令牌 → `setx CLAUDE_CODE_OAUTH_TOKEN "<token>"`；`wao doctor` 的 `claude_oauth_token_mode` 显示"长期令牌模式"即生效；迁移后跑一次全量 `npm test` 复验。迁移前勿派 native run——副本内续期会作废当前登录。
- **残留清理**：run 终态会删除本 run 创建的临时目录；进程崩溃等残留由 `npm run cli -- wao sweep-claude-config` 清扫（先不带 `--apply` 看清单）。

### 7.15 启动期退出：进程起来不久就退出，worker 一件事都没做（TD-180）

- **症状**：进程式后端启动后数秒到数分钟以 `process exited with code 1` 失败。`runs diagnose` 归 `crash`（用量到顶时归 `provider_capacity`，见下）；退出前零 worker 事件时另列一条"进程退出前未观察到任何 worker 事件（会话建立后 Ns 退出）"——这条事实不限于启动期，任何退出前没有 worker 事件的崩溃都会附，秒数说明它离启动有多远。
- **已知案例**（均为 codex 后端）：
  - 用量到顶：codex 的 JSON 输出里有 `{"type":"error","message":"You've hit your usage limit … try again at <时刻>"}`，WAO 读这一行——原话进终局 `run.error`，`runs diagnose` 据此归 `provider_capacity` / `quota_exhausted`，不再只报 crash。在任意目录跑 `codex exec --skip-git-repo-check --json "<一句无关的话>"` 就能看到原话和恢复时刻；到点之前重派都会失败。
  - 一例退出前零 worker 事件，stderr 带 `codex_models_manager: failed to refresh available models: request timed out`——启动期刷新模型列表超时。
  - 其余退出前已有若干 worker 事件，原因未明。
  - 多例 stderr 都以 `Reading additional input from stdin...` 开头，这是 codex 的常规提示，不是故障签名。除用量到顶外，把原任务原样再派一次，既往案例均成功。
- **WAO 不自动重试**（失败之后怎么办由 Lead 决定）。零 worker 事件的那一类，既往都是原样重派即成；但未观察到事件不等于没有副作用（输出缓冲、事件尚未落盘的窗口存在），重派前看一眼工作树。已有 worker 事件后才退出的，按普通中途失败处理：先看 retained worktree 里有没有半成品（§7.10 / §4.4）。
- **状态**：根因未明；诊断事实已补。

---

## 8. 测试套件与验证环境（canonical runner）

`npm test` 由 `scripts/canonical-test.mjs`（canonical runner）分波执行全量。本章按**失败形态与复验处置**组织（形态先行，不做环境归因）——特别是波内红、隔离绿的未归因形态（见 §8.1；处置 = 安静窗口单发复验通过后走单次 reverify）与主仓根 runs-guard 红灯（见 §8.2；处置 = 跑全量前确认无活跃 worker/daemon）。两者都表现为 "exit 1 + 顺序复跑绿"，但失败形态与复验处置不同：判定一律以**实际失败形态**（`isolation_pass` / `stable_fail` / `environment_invalid` / runs-guard 新增条目 / 波级 groupError / watchdog 中止）为准，顺序复跑变绿只是复验条件，不构成任何根因结论。何时跑全量、何时跑定向测试：见 `docs/testing.md`。

### 8.1 npm test exit 1 但失败全为 isolation_pass（波内红、隔离绿 ⇒ 原因未明）

- **症状**：全量 exit 1，stderrTail 中每一条失败分类行都是 `[canonical] isolation ... ⇒ isolation_pass`（首轮红、单文件隔离复跑绿）；无 `stable_fail`、无 `environment_invalid`、无其他形状的 fail。在 delivery verification / reverify 里表现为验证命令 `npm test` 失败。
- **第一反应（三步，按序）**：① 读 `delivery_verification_*` 事件的 `stderrTail`——携带 [canonical] 行全文，一次读取即得**文件名 + 波次 + 类别**；② 查 canonical 结构化报告的 isolation 分类行（`[canonical] isolation ... ⇒ isolation_pass` 形状，确认无 `stable_fail`/`environment_invalid` 混入）与 `firstRound.failures[].failureDetail`（首轮失败内容）；③ 按本节判定规则处置——全为 `isolation_pass` ⇒ 安静窗口单发复验后再走**单次 reverify**，不走 reject。
- **判定边界**：**波内红、隔离绿 ⇒ 原因未明**。隔离复跑绿只说明本次未复现，不能证明根因；首轮 exit 1 与失败内容仍是既成事实。历史失败**不能被追认为本次的原因**；**安静窗口单发复验是复验条件，不是归因证明**。
- **并发放大**：同机两会话并发跑全量会互踩并放大本现象（跨文件跨波连锁失败，撞车后只剩 reject+前作集成）；机器空闲顺序复跑恒绿。历史并发记录不构成对后续个例的归因。
- **判定规则（闭集）**：
  - **条件**：症状如上（exit 1 且 tail 全部条目为 `isolation_pass`，无 `stable_fail`/`environment_invalid`/其他 fail）。
  - **判定**：操作参数记 `environment_contaminated`（reverify 资格用的操作分类）——**它不代表根因已确认**；本次失败**原因未明**。
  - **行动**：**安静窗口单发复验通过后走单次 reverify**（复验前确认无其他全量/验证在本机在跑）。不走 reject——reverify 是单发机会，烧掉后只剩 reject+前作集成，等于再浪费一轮验证预算。
  - **反例**：tail 含**任何** `stable_fail` ⇒ 是真红，走正常 reverify/reject 路径，不得借本规则豁免。
- **预防（机器级 advisory inflight 标记）**：runner 开跑前（runs-guard 基线快照之前）在**机器级状态目录**（win32 `%LOCALAPPDATA%\wao`，回退 `~/.wao-machine`；经 `src/machineGatePaths.js`——该路径对 harness per-attempt TEMP 注入免疫）放 `wao-canonical-test.inflight` **机器全局 advisory 标记（非锁）**。同机另一全量在跑时，本套件 stderr 打一行 `[canonical] WARNING: another full suite started at <ts> (pid <n>) — results may be affected by resource contention`。**WARNING = 结果可能受资源争用污染，顺序复跑即可**——它永不阻塞、永不等待、不吃任何预算。崩溃残留的孤儿标记：pid 探活证死则降级为 `[canonical] NOTICE: stale inflight marker`，pid 活/不可判仍打 WARNING，不产生新失败面；标记在自己拥有的退出路径删除（仅删自己创建的那份；强杀路径不删）。
- **根治层（同机验证串行化闸）**：`verification.lease` 租约闸把交付验证与直连的 canonical 全量串行化，后到者排队，排队不计入任何预算，闸的争用与降级不改变验证结果；心跳、接管、`gate.log` 与人工破锁见[交付与验收](usage/delivery.md)场景 4b。inflight 标记保留为**降级态告警层**：fail-open、kill switch（`WAO_VERIFICATION_GATE=off`）、单文件跑等不经闸的场景仍由它兜底告警。运维出口：`npm run cli -- runs gate` 只读查询 free/held/corrupt 与 kill switch；`--release` 人工破锁仅限确认没有验证在跑而租约残留的场景（破除失败 fail-closed 非零退出）。

### 8.2 主仓根跑全量前确认无活跃 worker/daemon（runs-guard 红灯，TD-134）

- **症状**：主仓根 `npm test` 尾部 `[canonical] RED runs-guard: N new entries in the REAL runs/ ...`，exit 1——**即使全部测试通过**。
- **根因**：runs-guard 对 `runs/` 做基线-现状差分但**不做进程归属**——套件运行期间任何非套件写入者（活跃 daemon 追加 daemon-health、另一会话的 MCP dispatch、手动 `wao run`）落地的新条目都触发同一红灯。真实归因是"另一会话的 dispatch"，不是"测试写入"，但红灯文案无法区分。
- **前置确认（运维规程）**：**主仓根跑全量前确认无活跃 worker/daemon**（`runs dashboard` / 活跃 run 检查）。交付 worktree 管道天然免疫（worktree 无 `runs/` ⇒ 空基线）。
- **状态**：根修（进程归属或隔离 run-dir）待真实痛点再立项。

### 8.3 `npm test` 波次挂死或长滞（看门狗分诊）

- **症状**：全量在某波长时间无进展；stderr 每 5 分钟一行 `[canonical] NOTICE: wave=<name> running for <N>s (slow-wave alarm, informational)`；或尾部出现 `watchdog backstop fired` / 文件 `crashReason: "watchdog_timeout"`。三层看门狗把无限等待变成有界等待，并指名肇事文件/波。
- **三层防线（预算：per-test 1200s / 波级兜底 1800s / 告警 900s）**：
  - **R1 per-test 超时**（`--test-timeout`，主防线）：单个测试挂死（含同步死循环——Node 在文件级从父进程执行超时）按普通失败收杀；该文件记非 pass（超时测试不产生完成事件 ⇒ 报告中多为 `missing`），**同波其他文件不受影响**，波正常收尾。
  - **R2 波级兜底看门狗**（墙钟 1800s）：到期 `taskkill /PID <该子进程自己的 pid> /T /F`（只杀自己的进程树，绝不全局杀 node.exe）+ `kill(pid,0)→ESRCH` 探针确认死透（500ms × 3 次）。该波**全部文件**记 `crash` + `crashReason: "watchdog_timeout"`，groupError 含波名/已耗时/标记/清理状态。
  - **R3 慢波告警**（900s NOTICE 行）：纯读提示，不杀进程、不影响 verdict。
- **分诊**：读 `test-results.json`——`executionWaves[].watchdog`（fired/confirmed/elapsedMs/pid）与 `groupError` 指名波与耗时；该波 `files[]` 的 crash 条目即被连坐文件；`firstRound.failures[].crashReason` 与 isolation 条目的 `crashReason: "watchdog_timeout"`（分类 `stable_fail`——单独跑也挂死 = 真测试挂死，不是环境问题）指名肇事测试文件。R1 主防线腿（per-test 超时收杀）同样指名文件：挂死测试自身不产生完成事件，Node 以文件级失败事件（`details.error.message` = "test timed out after Nms"）收尾，reporter 把该文件 suite 记 `fail` + `fileFailure` 原因（v22.23.1 实测；同文件已通过的兄弟条目保留可见），该文件照常进入隔离重跑资格。
- **`cleanup unconfirmed`（红灯 + 套件提前停止，两条腿）**：兜底杀了但探针证不出死——疑似残留进程。stderr 文案与报告字段按中止来源区分：
  - **波腿**（stderr：`later waves were NOT started`）：后续波未启动；残留 pid 在 `executionWaves[].watchdog.pid`。
  - **隔离腿**（stderr：`isolation rerun stopped; no further reruns`）：首轮波其实已跑完，停的只是后续隔离重跑；残留 pid 在 `isolation[].watchdog.pid`（条目还带 fired/confirmed/elapsedMs/probes/limitMs 全字段）。

  两条腿都先用报告里的 pid 确认真死（`tasklist /FI "PID eq <pid>"`，仍在则 `taskkill /PID <pid> /T /F`），清干净再重跑；此时 verdict 必为 fail，不许带残留继续。runner 自身在报告落盘、全部打印之后强制非零退出（未确认残留子进程的管道句柄会阻止自然退出）；该强跳过 marker/gate 的收尾 finally，效果等同一次崩溃——孤儿 inflight 标记下次运行降级 NOTICE（pid 证死）/ 验证租约按陈旧超时接管，均为已 documented 的可恢复态。
- **主防线收尾后的孙进程残留（已知边界，非缺陷）**：R1 per-test 超时路径是"正常 close"收尾——正常 close 会撤掉看门狗、**不做树杀**。这是刻意语义：合法测试自己 spawn 的子进程不能被连坐处决；只有 R2 兜底路径才 `taskkill /T` 树杀。因此若被收杀的测试留下孤儿孙进程，它们可能残留到套件结束之后。症状：`npm test` 已退出（红或绿）但任务管理器/`tasklist` 仍有游离 node（或其它）进程，可能占端口、持锁文件或继续写文件。清理：该腿报告无 watchdog pid（看门狗未触发），按命令行特征定位——PowerShell `Get-CimInstance Win32_Process -Filter "name='node.exe'" | Select ProcessId,CommandLine` 找命令行含肇事测试文件路径（报告 `firstRound.failures[]` / `fileFailure` 指名的文件）的进程，`taskkill /PID <pid> /T /F` 收割；若同一波随后真触发了 R2 兜底，则直接用该波 `watchdog.pid` 树杀即可。
- **kill 环节自身挂住**：看门狗对 `killTreeFn` 设 10s 期限竞速（`KILL_TREE_DEADLINE_MS`）——taskkill 异常不返回时到期放弃等待、照常进探针环节（stderr 出现 `killTree did not return within ...ms — proceeding to liveness probes`），探针决定死活，看门狗自己绝不做无限等待。
- **后备：手工二分（适用于单文件复跑）**：拿到肇事文件后 `node scripts/wao-node.cjs --test test/<file>` 单发复跑确认仍挂；再在该文件内二分（注释后半部测试）定位具体挂死用例。

### 8.4 session reuse 关联面拒绝时的运维处置（ADR-0031 §3.6）

- **症状**：一次本应"复用上次会话"的派发被**拒**，文案属于固定四类（槽位存在但损坏 / 前任无可寻址 session id / 前任转录不可读 / runner 未拿到 id——四类全文与判定细则的单一权威是 `src/application/sessionReuse.js` 常量，ADR-0031 §3.6）。
- **这是刻意的 fail-closed**：ADR-0031 §3.6 要求"缺失/损坏时**拒绝**恢复，绝不静默新建会话"。看到拒绝**不要**当成故障去绕——静默新会话正是这条契约要防的。
- **状态在哪**：`<runDir>/.session-reuse/<sha256(opaqueUuid)>.json`（有界事实 `{runId, updatedAt}`；不含 provider session id——真源是前任转录的 `session.created.backendSessionId`）；lineage 面在 `.lineage-reuse/` 同构。
- **operator 恢复（唯一受支持的动作）**：确认无在飞 run 后，删除对应的那**一个**条目文件，下次同身份派发按"条目缺失"回到 `first`。不要手编条目内容（写入是原子 rename+校验，手编绕过校验），也不要删整个目录（一次丢掉全部身份关联）。
- **怎么定位是哪个 hash**：条目文件名即 `sha256(opaqueUuid)`（Lead 会话 + canonical workspace + agentId 派生，lineage 再加 `rootRunId`），磁盘不含原值（安全设计）无法反查——按最近被拒派发时间（`updatedAt`）缩小范围删对应条目。
- **已知不可达（非本节对象）**：条目被删（ENOENT）按合同回到 `first`——降级不是拒绝，不在 §3.6 fail-closed 范围（ADR-0031 §3.6 范围注）。
- **仍未闭合（已登记债务）**：resume 失败会永久孤儿化关联链（单槽指针被覆盖后按"终态无 session.created ⇒ first"降级，无显式断链信号）；本节 runbook 是当前唯一人工出口。

---

## 9. 新增条目（模板）

发现新坑时，复制此模板追加到对应章节：

```markdown
### 7.X <简短标题>

- **症状**：<观察到的现象>
- **根因**：<为什么发生，带证据——curl 输出 / transcript / 代码行>
- **验证**：<怎么确认是这个根因>
- **修复**：<怎么解决>
- **状态**：已修 / 待修（TD-XX）/ 不可修（外部限制）
```
