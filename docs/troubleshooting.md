# Troubleshooting（运维诊断手册）

> 定位：本文件是 WAO 运维/诊断的**按需读取层**。SKILL.md 是 agent 入口层（每次加载技能都读），
> 这里是**出问题时第一时间读的诊断手册**——记录已知的故障模式、根因、诊断套路、修复方法。
>
> SKILL.md 的避坑小节（opencode-serve operations & pitfalls）覆盖"避免踩坑"的预防知识；
> 本文件覆盖"已经踩坑了怎么诊断"的排障知识。两者互补。
>
> **新发现的坑请追加到对应章节末尾**（按 symptom/root-cause/fix 三段式），保持本文件持续更新。

---

## 快速索引（按症状）

| 症状 | 去哪看 |
|------|--------|
| worker 卡 `submitted` 直到超时 | [§1 provider 故障](#1-provider-故障) |
| worker 报 401 "身份验证失败" | [§1.2 serve 进程缺 key](#12-serve-进程缺-provider-key-401) |
| worker 静默无响应（无 error 无 message） | [§1.3 Kimi 白名单](#13-kimi-白名单静默拒绝) |
| opencode TUI 能用但 WAO 不能 | [§1.2](#12-serve-进程缺-provider-key-401) 或 [§1.3](#13-kimi-白名单静默拒绝) |
| 多行 prompt 被截断（只传第一行） | [§2 CLI 与 shell](#2-cli-与-shell) |
| worker 在错误的仓库目录干活 | [§3 工作目录](#3-工作目录cwd) |
| 终态 spawn_error：报 node.exe ENOENT 但 node.exe 存在 | [§3.2 cwd 目录不存在](#32-run-终态-spawn_error报错说-nodeexe-enoent-但-nodeexe-明明存在) |
| runs 状态池有大量 running 噪音 | [§4 运行数据运维](#4-运行数据运维) |
| run 完成了但 metrics 全 0 | [§5 证据完整性](#5-证据完整性) |
| worker 完成判定不可靠（过早 completed 或该完成没完成） | [§6 完成判定](#6-完成判定) |
| claude-code wrapper 401 / worker 连不上 provider | [§7.1](#71-claude-code-wrapper-401worker-连不上-provider) |
| worker 在错误项目目录干活 | [§7.4](#74-worker-在错误目录干活) |
| agents.json 配置过时/缺 tokenBudget | [§7.5](#75-agentsjson-配置漂移) |
| 不确定环境是否就绪 | [§7.6 wao doctor](#76-wao-doctor-体检) |
| run completed 但 messages 空 / 无 assistant text | [§7.7 证据链断链](#77-worker-输出证据为空但-run-completed证据链断链高危) |
| 认证判 draft-only/rejected 但模型应该会 | [§7.8 认证误判](#78-认证判-draft-onlyrejected-但模型其实会认证误判) |
| 改了 example 配置但 worker 行为没变 | [§7.9 agents.json 真相源](#79-agentsjson-vs-agentsexamplejson-混淆配置真相源) |
| `run_delivery` 返回失败面 / 不知道下一步用哪个交付工具 | [§delivery 失败模式 → 正确工具（闭集查表）](#delivery-失败模式--正确工具闭集查表) |

## delivery 失败模式 → 正确工具（闭集查表）

> 行为合同权威在 `docs/usage.md`（`run_delivery`、候选面 candidateInventory、`run_delivery_reverify` 各节）；本表是"现象→动作"runbook，表中枚举值由 docs-consistency 关系型守卫与 SSOT 同步。
>
> **跨切规则：任何 readiness 结果只要带 `candidateInventory`/`candidateKind`，先走候选路径（读 inventory → Lead 裁定 → `run_delivery_repackage` 结算），不按 readiness 标签直接人工核或重读。**

| 观察到的失败形状 | 正确动作 |
|---|---|
| readiness `not_requested`（`deliveryAvailable:false` + `deliveryRequested:false`） | 正常（非 delivery run），无需动作 |
| readiness `waiting_for_packaging`（非终态请求中） | 带 `waitMs` 重读（`run_delivery` / `runs delivery --wait-ms`）；不要 stop |
| readiness `waiting_for_verification` | 带 `waitMs` 重读；验证是控制面异步事实 |
| readiness `isolation_failed`（`isolationFailure.code` 为 `workdir_escape`） | **无任何 salvage 面**：不 repackage/reverify/review/decide/stop——重新派发 |
| readiness `packaging_failed` 且 `deliveryFailure.code` 为 `disallowed_path`（candidateKind `disallowed_scope`，带 candidateInventory） | 读 candidateInventory，Lead 裁定后 `run_delivery_repackage` |
| readiness `packaging_failed` 且 code 非 `disallowed_path`（其余包装失败码） | 无候选面：读 `deliveryFailure.code` + `run_diagnose`（只给事实），重新派发或人工核 |
| readiness `ambiguous` 且 candidateKind `backend_failed`（带 candidateInventory） | 候选路径：Lead 裁定后 `run_delivery_repackage` |
| readiness `ambiguous` 无 candidateInventory | fail-closed 折叠：人工核 transcript |
| 非终态 + candidateKind `process_missing`（readiness `waiting_for_packaging`，孤进程已证死） | `run_delivery_repackage`（first-terminal-wins 结算 orphan）——绝不等于语义 accept |
| reviewable + verification failed + reverify 原因 ∈ {`tooling_invalid`/`environment_contaminated`/`dependency_setup_missing`} 且原始失败码 ∈ 资格闭集 {`command_failed`/`command_timeout`/`execution_error`/`setup_failed`/`setup_timeout`/`setup_environment_error`} | `run_delivery_reverify` 一次（同 commit、原始断言不可改、只能追加 setup）；`artifact_mutated`/`artifact_mismatch` 不具资格 |
| reviewable | 逐页 `run_delivery_review`（fileIndex 至 cursor 尽头）→ `run_delivery_decide` |
| Host 传输中断/取消 | **什么都不做**：point-in-time 重读；绝不推断 run 已停 |

---

## 1. provider 故障

opencode-serve 是 HTTP 类 backend：worker 的任务由 serve 转发给 provider API。
故障可能发生在三层：provider 认证 / provider 白名单 / provider 模型行为。
**关键区别**：opencode TUI 正常 ≠ serve 正常——TUI 继承了终端 env + 可能带特殊 header，
serve 后台进程不一定。

### 诊断套路（worker 卡 submitted 时）

```
1. 查 transcript: runs/<runId>.jsonl
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
- **WAO 行为**：已修复（2026-06-17）——snapshot-stable 和 first-stable 都检测 `info.error`，立即 `done(failed)` 透传错误，不再卡超时
- **例外**：`MessageAbortedError` 是我们 abort 的副作用，不是 provider 错误，已排除
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
- **修复**：**用 `scripts/serve.ps1` 启动 serve**——它从 User registry 读 key 注入 serve 进程。
  不要用裸 `opencode serve`（可能不带 key）。serve.ps1 支持的 key：ZHIPU_API_KEY / KIMI_API_KEY / DEEPSEEK_API_KEY（新增 provider 在脚本 $keyNames 补一行）

### 1.3 Kimi 白名单（静默拒绝）

- **症状**：Kimi worker session 建立成功、prompt 投递成功，但**静默无响应**——无 assistant message、无 error message、WAO 卡 submitted 超时。opencode TUI 用 Kimi 正常。
- **根因**：Kimi 的 coding endpoint（`api.kimi.com/coding/v1`）做了**客户端白名单**，只接受认可的 coding agent 客户端。
  opencode.json 通过 `User-Agent: opencode/1.15.4` 伪装 header 过白名单——但这个 header 只挂在 **model id `kimi-for-coding`** 上（provider 层 + model 层都配了）。
  用其它 model id（`k2p6` / `kimi-k2.7`）没有 header 配置 → Kimi 静默拒绝（连 error 都不返回，WAO 无法靠 message.error 检测）。
- **验证**：
  ```
  # 直打 Kimi API 确认白名单
  curl -s -X POST "https://api.kimi.com/coding/v1/chat/completions" \
    -H "Authorization: Bearer <KIMI_API_KEY>" -H "Content-Type: application/json" \
    -d '{"model":"kimi-for-coding","messages":[{"role":"user","content":"OK"}],"max_tokens":5}'
  # 返回 "access_terminated_error" → 白名单拒绝（直打也不行，需 User-Agent header）
  ```
- **修复**：registry 里 Kimi worker 的 **model id 必须用 `kimi-for-coding`**（唯一带 User-Agent header 的）。
  providers.json 不要用 `k2p6`/`kimi-k2.7` 等其它 id。见 `config/agents.example.json` 里的 `coder_mm` 说明。
- **已知限制**：WAO 目前无法自动检测 Kimi 静默拒绝（无 error message）。靠 waitTimeout 兜底超时。未来可加"session 无 assistant message 超过 N 秒 → done(failed)"的检测。

### 1.4 DeepSeek-v4-flash 无限多轮

- **症状**：DeepSeek worker 回答后继续无限生成确认轮，token 烧到 waitTimeout
- **根因**：模型行为，每轮 emit step-finish 但 `time.completed` 永远不设
- **修复**：配 `completionMode: "first-stable"`（见 SKILL.md §4）。注意 first-stable 的完成判定对**多轮工具调用任务**有误判风险（§6.2）

### 1.5 kimi-code backend（进程式，阶段 2 新增）

- **是什么**：Kimi via `kimi-code` CLI（进程式 backend），官方支持 Kimi，过白名单无需伪装 header。进程死即会话死，不存在 opencode 的 stop 虚假成功风险（TD-37，06-18 事故根因）。
- **配置**：`backend: "kimi-code"`，`cwd` 必填。不要加 `--yolo`：`kimi -p` 模式与 `--yolo` 互斥。binary 默认走 PATH 里的 `kimi`（本机 `~/.kimi-code/bin/kimi.exe`）。
- **vs opencode Kimi**：kimi-code 更安全（进程式 + kimi 自带 max_steps_per_turn=100 + agent_task_timeout_s=900）。新任务优先 `coder_mm`。
- **已知局限：token 预算硬闸门（S1-1）对 kimi-code 无效**。kimi stream-json 不含 usage/token 字段，进程式 backend 无 session endpoint 可轮询。给 kimi agent 配 tokenBudget 不会报错但不生效。kimi 的成本控制靠：kimi 自带超时（15min）+ WAO `waitTimeout`。这是进程式 backend 的固有限制（claude-code/codex 同样无 session endpoint，但 claude-code 的 result 事件含 usage，kimi 不含）。
- **完成判定**：kimi 无显式 done 事件，靠进程 exit（exit 0 → done(completed)，非 0 → done(failed)），由 ProcessBackend 兜底。注意 exit 0 仅表示传输完成，不等于 worker 产出了可用结果——见 §6.3 末尾的 completed-empty 说明。

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
  这不是 WAO bug，是 shell quoting 问题。用 `\"` 转义双引号即可正常传递。
- **修复（PowerShell）**：
  ```powershell
  # ❌ 不行（单引号 JSON 被 PowerShell 吃掉）
  --scorecard-rules '{"requireEvidence":true}'
  # ✅ 正确（双引号 + 转义）
  --scorecard-rules "{\"requireEvidence\":true}"
  ```
- **验证**：transcript 应出现 `scorecard.checked` 事件；`runs scorecard <runId>` 应显示 checks

---

## 3. 工作目录（cwd）

### 3.1 worker 默认 cwd 是 WAO 仓，不是目标仓

- **症状**：worker 在 `D:/projects/windows-agent-orchestrator` 干活，而不是你要它改的目标仓库
- **根因**：registry 的 `cwd` 默认填的是 WAO 仓路径。每个 worker 的 cwd 应指向它要操作的目标仓
- **修复**：
  - 派发时显式 `--cwd "D:/path/to/target-repo"`
  - 或在 agents.json 里把每个 worker 的 cwd 改成目标仓
  - worktree 隔离时（`--isolate`），cwd 是 worktree 路径，自动正确

### 3.2 run 终态 spawn_error，报错说 node.exe ENOENT 但 node.exe 明明存在

- **症状**：派发/执行终态 `spawn_error`，`run.error` 写着 `spawn C:\...\node.exe ENOENT`，但该 node.exe 实际存在（2026-08-16 一批 22 条 researcher 派发即此形状）
- **判读**：**报错归咎 node.exe 但 node.exe 存在时，真因几乎总是 cwd 目录不存在**（Node spawn 的经典陷阱：`cwd` 选项指向不存在的目录时，ENOENT 会归咎到可执行文件名上）。工作目录来自显式 `--cwd`，否则来自 registry 条目的 `cwd`（example 模板里的 `D:/projects/your-project` 是文档占位路径，本机不存在）
- **现状**：已双层早拒绝——后台派发通道（`run --background` / `spawn` / MCP `run_dispatch`）在派发服务层（dispatchRun），前台执行通道（`run` 前台 / workflow agent 节点 / daemon `start`，进程式 backend）在 RunManager.start。预测 cwd 解析（`path.resolve`）后不是已存在目录（存在但是文件同样算）时，在任何 transcript 写入/worktree 创建/fork/spawn 之前抛 typed error `DispatchCwdNotFoundError`（reasonCode `dispatch_cwd_not_found`，message 含解析后的绝对路径与来源标注）。**旧 transcript 见此判读**
- **修复**：`--cwd` 指向已存在的目标目录，或把 agents.json / agents.example.json 里的占位 `cwd` 改成真实项目路径（派发/执行会显式拒绝并指路，不会再走到 spawn 期）

---

## 4. 运行数据运维

### 4.1 runs 状态池有大量 running 噪音

- **症状**：`runs summary` 显示很多 running，但都是历史遗留的 run（不是当前任务）
- **根因**：旧 run 没清理 + 之前的泄漏 session（session 未被 kill 的 run 永远卡在 running/submitted）
- **修复**：
  - 手动清理：`runs prune`（如已实现）或删除 `runs/` 下的旧 jsonl
  - 杀泄漏 session：`taskkill /IM opencode.exe /F`（会杀所有 serve session，慎用）
- **预防**：run 结束后 WAO 会兜底发送 abort，并在 opencode 类 handle 上做后台 quietness 验证（TD-37/TD-38）。历史遗留 session 仍需手动清。

### 4.2 旧泄漏的 serve session（quota 风险）

- **症状**：serve 进程里有多个 ESTABLISHED session，对应已结束的 run，仍在烧 token
- **根因**：2026-06-16 之前的 run 没有兜底 abort（bug 已补）。DeepSeek/GLM 这类模型会一直烧到 quota。
- **现状**：`stop` 命令和 RunManager 终态清理路径都接入后台 quietness 验证（TD-37/TD-38）——abort 后联合观察 OpenCode session status 与 token/message 稳定性。观察面不可读会诚实记录 unverified；确认仍 active 时告警，但不会自动全局 taskkill 其他 session。**仍务必给每个 opencode agent 配 `tokenBudget`**，这是不依赖 abort 生效的最后一道防线。
- **修复**：`taskkill /IM opencode.exe /F` 杀 serve（连带所有 session），用 serve.ps1 重启
- **诊断**：`netstat -ano | findstr :4298 | findstr ESTABLISHED` 看 session 数

### 4.3 run_await_result 返回 read_failure（transcript 读失败）

- **症状**：`run_await_result` 返回 `observationOutcome=read_failure`，`result.status=unavailable`
- **机器协议（M12-6 FR-08）**：同时携带闭集 `readFailureReason`，Lead 可直接按码决策，不需要读错误原文：
  - `transcript_parse_failed` — transcript 读取/JSON 解析异常（文件缺失、不可读、某行 JSON 损坏）
  - `legacy_event_shape` — 快照含 JSON 合法但不可用的历史条目（null / 原始值 / 数组），或快照不是数组
  - `snapshot_unavailable` — 其他安全的非解析类失败（如残留投影派生失败）
- **根因**：transcript 文件损坏或被截断写入（进程被杀、磁盘满、跨进程并发写同一 jsonl）
- **修复**：检查 `runs/<runId>.jsonl` 完整性；`transcript_parse_failed` 多为写入中断，`legacy_event_shape` 多为旧格式历史数据。控制面**绝不泄漏**错误 message/path/command/credential——字段只有闭集码，成功路径（observed）为 `null`
- **注意**：unexpected 内部异常仍是固定 opaque 错误（`run_await_result failed`），不会变成 success 形状

---

## 5. 证据完整性

### 5.1 metrics 提取（已修复）

- **症状（已修）**：run 成功 completed，但 `run.metrics` 记 `tokens:{input:0,output:0}`，实际 provider 用了几万 token
- **根因**：message.info.tokens 在流式传输期间是 0（serve 在 message 完成后才回填），snapshot-stable 提取 metrics 时读到的是流式占位值
- **修复**：metrics 现从 **session endpoint**（`GET /session/{id}`）提取累计 tokens——serve 维护的累计值，比 message.info.tokens 可靠
- **验证**：GLM run 现返回真实 token（input:27185, output:4），不再 0

---

## 6. 完成判定

WAO 的完成判定有两种模式：`snapshot-stable`（默认）和 `first-stable`（配 `completionMode`）。

### 6.1 snapshot-stable 对慢响应 + 短 timeout 误判超时

- **症状**：worker 实际回复了，但 run 还是 timed_out
- **根因**：snapshot-stable 需要两轮稳定（看到 assistant → 等 interval → 快照不变 → done）。
  如果 waitTimeout < (响应时间 + 2×interval)，第二轮确认来不及就超时
- **修复**：对慢响应模型（GLM 首次冷启动 ~30s），waitTimeout 设为响应时间的 2-3 倍。或用 first-stable（快，但有 §6.2 风险）

### 6.2 first-stable 完成判定（C' 重设计，已修复）

- **症状（已修）**：DeepSeek worker 读完第一个文件就被判定 completed，没完成整个调研任务
- **根因**：旧 first-stable 把"首条 assistant 有 step-finish"等同于完成。但 DeepSeek 每轮（含工具轮）都 emit step-finish，
  所以多轮任务在工具轮（msg[0]）就被截断
- **实测证据**（同一任务三方案对比）：
  - 旧 first-stable（step-finish）：msg[0] 有 tool+step-finish 无 text → 截断，没给答案 ❌
  - snapshot-stable：msg[1] 给答案后无限重复 18 次（DeepSeek 无限循环）❌
  - **C'（首条含 text part）**：msg[1] 给 text 答案 → 完成 + abort，不再重复 ✅
- **修复**：first-stable 判据从"有 step-finish"改为"首条含非空 text part 的 assistant message"。
  text part 精确区分"还在干活（工具轮，有 tool 无 text）"和"给出答案（text 出现）"

### 6.3 ProcessBackend（claude-code/codex）exit 1 → done(failed)（已实现）

- **症状**：claude-code worker 进程 exit code 1，run 状态不干净（没 done(failed)，没 metrics）
- **根因（已排除）**：ProcessBackend 流结束时**已有** exit-code 兜底——无 done 时按 exit code：0→completed，非 0→done(failed)。实测确认：进程式 worker exit 1 → `run.error "process exited with code 1"` → state failed
- **metrics 缺失（不可避免）**：claude 进程在打印最终 `type:"result"`（含 token usage）**之前**崩溃 → result 事件从未产生 → metrics 无法提取。这不是 WAO bug，是进程崩溃的固有后果
- **结论**：exit-1→failed 链路正确；crash run 的 metrics 丢失不可修复（数据源没产生）
- **M12-21 completed-empty（exit 0 ≠ 有用结果）**：进程 exit 0 → `done(completed)` 仅是**传输完成**，不是 worker 产出可用结果的证据。一个 completed run 若只有 transport 活动（runtime initialized/streaming、thinking、zero-usage metrics）而**没有任何可用产出**（assistant 文本、命令活动、文件写入、tool_use/tool_result），不再被当成一次正常完成：诊断归类 `no_effect` + 事实码 `completed_empty`（`src/diagnosis.js` 的 `NO_EFFECT_DIAGNOSIS_CODES`），主控据此不会把空转 worker 误判为有效 review/delivery。Lead 校正后**线路与内核统一**：MCP `run_diagnose`/`run_await_result` 把 `category=no_effect` 与 `code=completed_empty` **同时**透出到 wire（`code` 闭集为单一通用 `DIAGNOSIS_CODES` SSOT，经 `isValidDiagnosisCode(category, code)` 配对校验；**failed** 的 `no_effect` run 仍 `code=null`，正常 completed 仍 `none/null`）；ProcessBackend 也在流边界对"成功但无可用产出"的完成直接打 `completed_empty` 机器事实（parser `done(completed)` 与 exit-0 兜底两条路径同时生效）。有效的 tool-only / command-only / file-written 完成仍判 `none`。

### 6.4 worker 失败时主控收不到证据（已修复）

- **症状（已修）**：worker failed 时 `waitForCompletion` 抛错，CLI 不 catch → 主控看到 CLI exit 1 无输出（没有 runId/error），无法决定是否接手
- **修复**：CLI 的 `runAndWait(run, options)` 包装 `waitForCompletion`，捕获 failed 抛错，转为结构化结果：
  ```json
  {"runId":"run_xxx","completed":false,"failed":true,"timedOut":false,"error":"provider error [401]: 身份验证失败"}
  ```
  主控现在能看到 runId（定位 run）+ error（决定是否接手）。`run`/`spawn --wait`/并行 wait 三个路径都已接入。
- **主控接手决策**：收到 `failed:true` 后，主控可：读 transcript（`runs/<runId>.jsonl`）看详细证据 → 判断失败原因（可恢复/不可恢复）→ 决定重试、换 worker、或自己接手

### 6.5 snapshot-stable 伪完成（codex 实测暴露，已修复）

- **症状（已修）**：GLM coder 多轮任务 `completed=true` 但 `assistantTextCount=0`——读了文件（tool part）给 step-finish，但没给 text 答案，snapshot-stable 判 completed
- **根因**：snapshot-stable 的 completed 判定只要求"快照稳定"，不要求"有 text 答案"。GLM 在 tool-call 轮的 message 有 tool part（非 step-start）→ 触发 hasAssistant → 两轮稳定 → completed，但这一轮是中间态无答案
- **修复**：snapshot-stable 的 completed 判定现在要求至少一条 assistant message 有非空 text part（与 first-stable C' 对齐）。无 text 则重置观察状态继续等，不判 completed
- **纵深防御**：scorecard 新增 `requireAssistantText` 规则——即使完成判定漏了，scorecard 也会拦截"completed 但无 assistant text"
- **验证**：GLM 读两 sentinel 文件 + 输出含内容的 JSON，snapshot-stable 正确等待到 text 答案才 completed（E2E 通过）

### 6.6 静默无响应早失败（silentTimeout，已实现）

- **症状（已修）**：Kimi 白名单 / 不存在的 model：serve 不产 error message 也不产 assistant message → 只能等完整 waitTimeout
- **修复**：两个完成模式都加 `silentTimeout`——超过该时长仍无 assistant message 无 error → `done(failed)` ("silent timeout")。默认不启用，需在 streamEvents 调用时传 silentTimeout（ms）

### 6.7 first-stable metrics 偏小（codex 实测暴露，已修复）

- **症状（已修）**：first-stable 的 CLI metrics `input:408`，但 serve session 实际 `input:29706`
- **根因**：first-stable 旧从 `firstAssistantFinished.info.tokens`（首条 message 瞬时值）提取，不是累计值。DeepSeek 多轮工具调用真实消耗远大于首条
- **修复**：first-stable 完成后从 session endpoint 取累计 metrics（abort 前取，值最准），回退 message.info.tokens

---

## 7. 进程式 backend + 部署（claude-code/kimi-code/codex）

主力已切进程式（06-18 事故后弃 opencode）。这章覆盖进程式路径的坑 + 实机部署问题。

### 7.1 claude-code wrapper 401（worker 连不上 provider）

- **症状**：coder_hq/coder_low/researcher（claude-code wrapper 路径）报 `401 Invalid authentication credentials` / `身份验证失败`
- **根因 A：provider key 没进 Lead runtime env**。wrapper 用 `ANTHROPIC_AUTH_TOKEN` 注入认证，它读的是 `process.env.<KEY_ENV>`（如 ZHIPU_API_KEY）。如果 Lead runtime 进程没继承这个 env（key 在 User registry 但没进 runtime 的 env），wrapper 拿不到 key → 401。
- **根因 B：claude-code OAuth 登录态覆盖 provider key（已修 TD-59）**。当 `~/.claude/.credentials.json` 含 `claudeAiOauth` 时，claude-code 可能优先用 OAuth accessToken，忽略 wrapper 注入的 `ANTHROPIC_AUTH_TOKEN`，把 Claude OAuth token 发到 DeepSeek/ZHIPU base URL → 401。现 wrapper 给 provider worker 设置独立的 `CLAUDE_CONFIG_DIR`（`.wao-worker-claude-config/`），隔离用户 `~/.claude`，避免 provider worker 读取 Claude OAuth 凭证；auditor 不走 wrapper，仍使用官方 Claude OAuth。
- **验证**：`npm run cli -- wao doctor` 会查 key 是否在 env。或手动 `echo $ZHIPU_API_KEY`。若 key 存在但 provider worker 仍 401，检查 transcript 的 provider error；OAuth 覆盖类问题通常表现为 token tail 与 provider key tail 不一致。
- **修复**：确保 key 在 User registry（`[System.Environment]::SetEnvironmentVariable('ZHIPU_API_KEY','<val>','User')`），重启 runtime 让它继承。使用已含 TD-59 的 WAO 版本；不要把 `~/.claude/.credentials.json` 复制到 `.wao-worker-claude-config/`。

### 7.2 DeepSeek variant=max 不能用 model 后缀

- **症状**：`--model deepseek-v4-flash:max` 报 `400 The supported API model names are deepseek-v4-pro or deepseek-v4-flash`
- **根因**：DeepSeek anthropic 端点只认 `deepseek-v4-flash` / `deepseek-v4-pro`，variant 不是 model id 的一部分
- **修复**：variant=max 用 `--effort max`（映射到 `CLAUDE_CODE_EFFORT_LEVEL=max` env），**不要**塞进 model id

### 7.3 auditor（claude-code Opus）401

- **症状**：auditor worker 报 401
- **根因**：auditor 用官方 Claude（不走 wrapper），需要 claude-code 自己的认证（`claude login` 或 API key），不是 provider key
- **修复**：`claude login` 完成官方认证（owner 已验证，2026-06-24）

### 7.4 worker 在错误目录干活

- **症状**：worker 在 WAO 工具仓或错误项目干活，不在目标项目
- **根因**：派发时没带 `--cwd <目标项目>`，worker 用了 agents.json 的默认 cwd（占位符 `.`）
- **修复**：**每次派发必须带 `--cwd <目标项目>`**。agents.json 的 cwd 是占位符，由 Lead 动态覆盖

### 7.5 agents.json 配置漂移

- **症状**：worker 用了过时的配置（旧 worker 名、缺 tokenBudget、backend 不认）
- **根因**：agents.json 没和 team-roles.md 同步，或用了旧版配置
- **验证**：`npm run cli -- registry validate --registry config/agents.json` 检查所有 worker。opencode worker 必须有 tokenBudget
- **修复**：对照 `docs/team-roles.md` 更新 agents.json，重跑 registry validate

### 7.6 wao doctor 体检

- **何时跑**：部署前、出问题时第一件事、定期
- **命令**：`npm run cli -- wao doctor [--registry config/agents.json] [--cwd <目标项目>] [--format json]`；CI 想把 WARN 也卡成非零退出可加 `--warn-as-error`（只改退出码，不改报告内容）
- **检查项**（scoped——只按 registry 里保留的 worker 收窄，不再 4 CLI / 3 key 全查）：
  - Node 版本（>=22）
  - 保留 worker 需要的 CLI 在 PATH（没有 worker 需要的 CLI 显示 INFO 跳过，不判 FAIL）
  - 保留 worker 声明的 provider key（进程 env 或 Windows User 作用域；kimi-code 走 CLI 登录态，不查 API key）
  - agents.json 完整性（opencode worker 必须配 tokenBudget——06-18 事故防线）
  - 目标项目的 `.wao/` 是否 init（未 init / fresh clone 缺槽位是 WARN，结构混乱才是 FAIL）
- **判读**（advisory，非门禁——doctor 不自动阻断任何派发，verdict 行自带"（advisory，非门禁）"标注）：
  - `HEALTHY`：无 FAIL 无 WARN，可直接继续
  - `DEGRADED（N warn）`：仅 WARN（如 User 作用域 key 未继承、.wao 未 init），可直接继续
  - `BROKEN（N fail[, M warn]）`：有 FAIL——按每条 FAIL 的 `run:` 提示处理（装 CLI / `setx` 配 key / `wao init`），处理后由你（Lead/owner）裁定是否继续

### 7.7 worker 输出/证据为空但 run "completed"（证据链断链，高危）

- **症状**：run `completed=true` 有 metrics，但 `messages` 空 / `assistantTextCount=0` / 命令证据缺失 → 认证 draft-only/rejected，或真实任务 Lead 收不到 worker 回复
- **第一反应（纪律）**：**别先怀疑模型能力**。"completed 但空"几乎总是**证据提取断链**，不是模型没做。先抓原始 stream-json 看模型到底输出了什么，再判断
- **根因 A（已修 03a20e0）**：claudeCode parser 按 `message.id` 去重，但 claude-code 对同一 message 的 thinking 块和 text 块分两条 stream-json 行发出、共享同一 id → text 行被当重发丢弃。**抓原始 stream-json 看到 text 行存在但 transcript 没有即可定位**
- **根因 B（已修 466bca8）**：`extractToolUse` 只认 `name==="Bash"`，Windows 上 claude-code 暴露 `PowerShell`/`Cmd` → 命令掉到通用 toolUse，commandsPassed 找不到命令
- **验证**：直接跑 `claude -p "..." --output-format stream-json` 抓原始输出，对比 transcript——若原始有但 transcript 没，就是 parser 没捕获
- **修复**：parser 已修（dedup 按 id+content 签名；命令工具认 Bash/PowerShell/Cmd）。升级 WAO 到含这两个 fix 的版本
- **教训（决策 0009）**：观测异常（空输出）+ 领域常识（LLM 当然会回复/跑命令）矛盾时，**先查证据链再下结论**

### 7.8 认证判 draft-only/rejected 但模型其实会（认证误判）

- **症状**：`npm run reliability` 报 worker `draft-only`/`rejected`，看起来"模型不会跑命令/不会写文件"
- **第一反应（纪律）**：**别接受异常结果**。2026 年主流 LLM 都会跑命令+写文件。draft-only 多半是证据没捕获（见 7.7），不是能力缺失
- **典型根因**：parser 漏认 Windows 命令工具（7.7 根因 B）→ commandsPassed 永远失败 → 看似"不会跑命令"
- **验证**：抓认证 drill 的原始 stream-json，确认模型是否真的发了 tool_use（Bash/PowerShell）。发了但 commandsPassed=false = parser bug，不是模型问题
- **修复**：升级 parser（466bca8）。修后 researcher/coder_hq/coder_low 从 draft-only 直接冲到 `certified`

### 7.9 agents.json vs agents.example.json 混淆（配置真相源）

- **症状**：改了 `agents.example.json` 但 worker 行为没变；或认证报 worker 不存在
- **根因**：runtime/reliability 套件读的是 `config/agents.json`（**gitignored，本机实际生效**），不是 `agents.example.json`（提交的模板）。两者可能不同步——example 是权威模板，agents.json 是落地实例
- **验证**：`node -e "console.log(Object.keys(require('./config/agents.json').agents))"` 看实际 worker 名
- **修复**：以 `docs/team-roles.md` 为权威，**两个文件都同步**。改 example 后复制到 agents.json（反之亦然）
- **状态**：决策 0008 已把 example 对齐 team-roles；agents.json 也已跟齐（2026-06-24 验证）

### 7.10 backend 最后失败，但 retained worktree 里已有候选改动

- **症状**：delivery run 因 `backend_error` 或 `backend_stream_ended` 终态失败，没有 DeliveryRef；但 worker 在隔离 worktree 已写入文件。
- **先查事实**：调用 `run_delivery`。只有返回 `candidateKind:"backend_failed"` 且 `candidateInventory` 完整非空，才表示 WAO 已证明 runtime quiet、exact base、workspace ownership 和候选清单；null 不是“无成果”，而是需由 Lead 人工核实。
- **恢复**：Lead 审查 inventory 后明确提供完整 `allowedPaths`，调用 `run_delivery_repackage`。它不调用模型、不恢复 provider session，只在原 worktree 机械重算范围、打包并运行原验证声明。
- **裁决**：重封装后仍逐文件审查，并由 Lead 单独 accept/reject。WAO 不判断候选语义、不自动扩域、不自动重试；缺 `run.stop_verified`、HEAD 漂移、冲突事件、空/截断 inventory 均不提供该恢复路径。

### 7.11 Claude Code 新版 partial stream / retry 状态与 cache token

- **症状**：长推理期间只看到粗粒度 thinking；provider retry 看起来像静默；或 Claude 的 cache creation token 被统计成 reasoning token。
- **根因**：旧 adapter 未启用 `--include-partial-messages`，忽略 `system/api_retry`，并把 `cache_creation_input_tokens` 错映射到 `reasoning`。
- **修复**：Claude backend 启用 partial stream，并把 init/streaming/retry 只投影成 payload-free 闭集 `runtime_activity`；stream delta 按固定间隔采样，原始文本/error/session/model 不落 transcript。cache read/write 使用独立指标字段。
- **隔离**：WAO Claude worker 设置 `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`；delivery mode 额外设置 `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`。普通一次性 run 使用 `--no-session-persistence`，显式 session reuse 不使用该 flag。
- **验收边界**：本地 parser/wrapper/argv/env 与 synthetic stream 可 no-model 验证；官方 Claude/真实 provider 行为仍需具备对应订阅或 credential 后单独 canary，不得用本地测试冒充真实 runtime 验收。

### 7.12 DeepSeek Harness JSON-RPC backend 启动或空结果

- **先确认边界**：WAO 只 detect/invoke/report，不安装、升级、登录或修复 DSH。GUI 中选择的 preset 不会自动成为 WAO worker；WAO 使用 registry 明确指定的 dedicated `dsh-jsonrpc-agent` + Cordis config。
- **preflight 报配置错误**：确认 `binary` 可执行、`dshConfigPath` 可读、`credentialEnv` 为非空环境变量名；用 `registry validate` 检查静态合同，用 `registry list` 检查 credential availability。
- **runtime identity mismatch / malformed JSON-RPC / transport closed**：这是 DSH composition 或 transport 故障，不是模型语义失败。直接运行同一 binary 做 `initialize` no-model probe；不得改成抓 TUI 文本或把未知输出投影为 completed。
- **内部 subagent 事件导致失败**：这是预期 containment。WAO 的 worker 不能再通过 DSH 内部编排绕过 Lead/WAO；关闭 composition 中的 subagent/workflow 后再派发。
- **认证显示 null**：认证按 agent id + backend + model 绑定。把同名 worker 从 claude-code 切到 DSH 后，旧认证不会继承；先做真实 canary，再由 Owner 决定是否运行完整 reliability。

---

## 8. 新增条目（模板）

发现新坑时，复制此模板追加到对应章节：

```markdown
### 7.X <简短标题>

- **症状**：<观察到的现象>
- **根因**：<为什么发生，带证据——curl 输出 / transcript / 代码行>
- **验证**：<怎么确认是这个根因>
- **修复**：<怎么解决>
- **状态**：已修 / 待修（TD-XX）/ 不可修（外部限制）
```
