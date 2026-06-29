# WAO Changelog — post-M6 修复轮（2026-06-16 ~ 2026-06-17）

## 当前版本快照

**项目**：Windows Agent Orchestrator (WAO) — Windows 原生、headless、runtime-agnostic 的本地 agent runtime 编排器

**代码状态**：268 tests pass / 0 fail，reliability 套件全绿（GLM + DeepSeek + silentTimeout），工作树干净

**可用 provider**（经实战验证）：

| Provider | Model | Backend | 完成模式 | 实测状态 |
|---|---|---|---|---|
| 智谱 | GLM-5.2 | opencode-serve | snapshot-stable | ✅ 可用 |
| DeepSeek | deepseek-v4-flash | opencode-serve | first-stable | ✅ 可用 |
| Kimi | kimi-for-coding | opencode-serve | first-stable | ✅ 可用（需 model id kimi-for-coding） |
| Anthropic | claude (default) | claude-code (process) | process | ✅ 可用（需 --dangerously-skip-permissions） |
| OpenAI | codex (default) | codex (process) | process | ✅ 可用 |

---

## 更新内容

### 事故与可靠性修复

**DeepSeek quota 黑洞事故修复**（commit 03374cf）
- 问题：RunManager 终态路径（completed/failed/timed_out）不调用 serve session abort，DeepSeek 无限模型在后台烧光当日 quota
- 修复：`_runCleanup()` 兜底调 `handle.abort()`（幂等 `_sessionKilled` flag），所有终态路径都发送 abort；后台 session/token 静默验证后续归入 TD-37
- 复盘：`docs/incidents/2026-06-17-deepseek-quota-drain.md`

**Provider 错误 fast-fail**（commit 5a505f8）
- 问题：opencode serve 把 provider 401/欠费/限流包成 `info.error` message（parts 为空），旧逻辑看不到 → 卡 submitted 烧超时
- 修复：snapshot-stable 和 first-stable 都检测 `info.error`，秒级 `done(failed)` + 透传错误。排除 `MessageAbortedError`（abort 副作用）

**snapshot-stable 伪完成修复**（commit f008331，codex reliability-lab 暴露）
- 问题：GLM 在 tool-call 轮给 step-finish 但无 text，snapshot-stable 误判 completed（assistantTextCount=0）
- 修复：snapshot-stable 现在要求至少一条 assistant message 有非空 text part 才 completed（与 first-stable C' 对齐）

**first-stable 完成判定 C' 重设计**（commit 89ed15e）
- 问题：旧 first-stable 看 step-finish 判完成，但 DeepSeek 每轮（含工具轮）都 emit step-finish → 多轮任务第一轮就被截断
- 修复：判据从"首条有 step-finish"改为"首条含非空 text part 的 assistant message"。实测三方案对比：旧 step-finish 过早截断，snapshot-stable 无限循环 18x，C' 读完文件给一条答案即停

**first-stable metrics 修复**（commit f008331，codex reliability-lab 暴露）
- 问题：CLI metrics input:408，session 实际 29706（旧逻辑从首条 message 的瞬时 token 读）
- 修复：first-stable 完成后从 session endpoint 取累计 metrics（abort 前取，值最准）

**snapshot-stable metrics 修复**（commit 4e65b43）
- 问题：metrics 全 0（message.info.tokens 流式期间是 0）
- 修复：metrics 改从 `GET /session/{id}` 取 serve 维护的累计值

**silentTimeout 早失败**（commit f008331 + 281e245）
- 问题：Kimi 白名单/不存在 model 静默无响应（无 error 无 assistant），只能等完整 waitTimeout
- 修复：两个完成模式都支持 silentTimeout——无 assistant 无 error 超过阈值 → `done(failed)`。CLI `--silent-timeout` / registry / config 三层可配

**Kimi 白名单修复**（commit d497b58）
- 问题：Kimi coding endpoint 客户端白名单，用 k2p6/kimi-k2.7 被静默拒绝
- 修复：registry model id 必须用 `kimi-for-coding`（唯一带 User-Agent 伪装 header 过白名单的）

### CLI 与主控通知

**Worker 失败结构化通知**（commit 1ca22e7）
- 问题：worker failed 时 CLI exit 1 无输出，主控看不到 runId/error 无法决定是否接手
- 修复：`runAndWait()` 包装 `waitForCompletion`，捕获 failed 抛错转 `{runId, failed:true, error}` 结构化结果

**Lead Operator 角色定义**（commit 5a505f8）
- 新增：SKILL.md 正文最前，告诉加载技能的 agent 它是主控（非单体 coder），职责链理解/编排/派发/验收/整合/汇报

### 运维基础设施

**serve.ps1 启动脚本**（commit c9ff6d2 + d497b58）
- 从 User registry 读 ZHIPU/KIMI/DEEPSEEK key 注入 serve 进程，根治"opencode TUI 正常但 WAO 401"
- 纯 ASCII（PowerShell 5.1 编码兼容），经 cmd.exe /c 启动，Get-NetTCPConnection 健康检查

**Scorecard requireAssistantText**（commit f008331）
- 纵深防御：scorecard 新增第 5 条检查规则，防 completed 但无 assistant text 的伪完成放行

### 测试与质量体系

**Reliability 套件**（commit d2313f1 + 308276f）
- `npm run reliability`：sentinel 方法验证完成模式 × provider 矩阵（读文件再答，防伪完成/背诵/截断）
- 断言：completed + assistantTextCount>0 + sentinel 内容正确 + metrics 来自 session
- 测试 silentTimeout 早失败
- milestone-discipline §6.6（修一处必须验证所有同类路径）+ §6.7（reliability 是完成判定/provider 修改的硬门槛）

**docs-consistency 不变量守卫**（17 断言）
- 端口一致、TD 注册齐全、transcript 单一权威、spec 无虚列、onboarding 避坑齐全、lead 角色定义存在、troubleshooting 存在

### 文档

**troubleshooting.md**（commit aa70226）— 按需读取诊断手册，覆盖 provider 故障/CLI&shell/cwd/runs 运维/证据完整性/完成判定，每条 symptom→root-cause→fix + 验证命令，§7 留扩展模板

**tech-debt.md** — TD-1~TD-35 统一登记表（17 已偿还 + 17 开放 + 1 设计约束）

**SSOT 文档对齐**（commit 0e49466 + 5188c40）— README 薄入口、spec 进度标注清理、进度/技术债/transcript 单一权威 + 指针

---

## 目前能力边界

### WAO 现在能做的

- **多 provider worker 调度**：spawn/run/status/tail/collect/stop/retry/resume，三 opencode provider（GLM/DeepSeek/Kimi）+ 两进程式（claude-code/codex）
- **完成判定**：snapshot-stable（默认，要求 text 答案）+ first-stable（C'，首条 text 即完成，防无限循环）
- **证据链门控**：scorecard 5 条规则（hasDoneEvent/commandsPassed/filesExist/hasEvidence/requireAssistantText），opt-in
- **DAG 工作流**：参数化模板（`{{placeholder}}` + `--vars`），并行/串行/扇出/gate/router
- **隔离与恢复**：git worktree 隔离 + resume（opencode attach / process replay）
- **可观测**：metrics（session endpoint 累计 token/cost）+ JSONL transcript（完整事件流）
- **可靠性验证**：`npm run reliability` sentinel 套件，完成模式 × provider 矩阵
- **错误处理**：provider 401 fast-fail、silentTimeout 早失败、session 兜底 kill、worker 失败结构化通知主控

### WAO 现在不能做的（已知边界）

| 限制 | 状态 | 影响 |
|---|---|---|
| 无 daemon（进程退出则 opencode-serve 之外的 run 消失） | M7 范围 | 后台长跑需手动保持 serve |
| opencode evidence 提取（TD-33） | schema 已勘测，待落 parser | opencode worker 的 scorecard 只能跑 hasDoneEvent/hasAssistantText |
| Kimi metrics 全 0 | Kimi session endpoint 不返回 tokens | Kimi run 无法用 metrics 判断工作量 |
| §2.2 CLI run 成功但 exit code 1 | 待诊断 | 不影响 run 结果，shell 退出码误导 |
| 并发限流调度器（TD-5） | 未实现 | 并行 run 无信号量 |
| 副主控（M7） | 未实现 | 多 lead 协作、红队评审未落地 |
| LLM 编排器（M7） | 未实现 | 自动任务分解/动态编排需主控自行推理或用 workflow DAG |

### 未实战验证的路径

- claude-code（coder_strict）在修 scorecard 后未重测（上次 crash 是进程问题，非 WAO bug）
- codex（tester）本轮未测
- 大型 DAG workflow（3+ 节点 + 混合 provider）未实战

---

## 诚实定位

WAO 经历两轮实战测试 + codex reliability-lab 独立验证后，从"可追溯派发器"向"可信赖验收器"显著迈进：

- **完成判定可靠了**：snapshot-stable 要求 text 答案，first-stable C' 精确区分工具轮与答案轮
- **失败能看见了**：provider 401 fast-fail、silentTimeout 早失败、runAndWait 结构化通知
- **证据真实了**：metrics 来自 session endpoint，scorecard requireAssistantText 防伪完成
- **验证固化了**：reliability 套件可复跑，不再靠手动 ad-hoc

**但还不是"完全可托管"**：无 daemon、无并发调度、opencode evidence 未提取。当前适合**主控驱动 + 人类护栏**的半自动编排，不适合完全无人值守（M7 目标）。

---

## M8：Lead 体验层（2026-06-26）

> 过程类追加。M8 把"编排便利性"下沉为工具默认行为，严格遵守三分准则：
> 🟢 工具域（确定性脏活）全自动 · 🟡 Lead 域（高语义）工具不介入 · 🔵 工具起草 Lead 拍板。

**起因**：M0–M7 把"原子能力"做完后，Lead 体验仍停留在"自己脑子拆解 + status/tail/collect/metrics 四命令轮询 + 记得配 scorecard + 记得派 auditor"。差距集中在 Lead 的认知层。本轮把散落在 SKILL 指引里、靠 Lead 手动拼的编排智能下沉成工具默认行为——但**只下沉机械/确定性部分，高语义判断（拆解/故障应对/是否需 auditor/终验意图）全留 Lead**。

**5 项落地**（按依赖序，每项独立 TDD red-green + 验收 gate）：

| # | 项 | 三分归属 | 形态 |
|---|----|---------|------|
| M8-1 | 默认 scorecard(warn) + `--scorecard-mode` 三态 | 🟢 工具域 | 防伪完成从 opt-in 升级为默认 warn（不阻塞只留痕）；hard 升级硬闸/off 关闭。显式 rules 优先 |
| M8-2 | `runs dashboard` 实时仪表盘 | 🟢 工具域 | 单一视图聚合所有 run 状态/token/费用/证据 + 异常标红；`--watch N`/`--format json`/`--agent`/`--latest`。只读聚合，绝不 retry/stop |
| M8-3 | `runs diagnose` 故障诊断 | 🔵 工具起草 | 只给【证据】（category + 引用事件），绝不给【处方】。处方权（retry/换 worker/接管）全留 Lead。铁律由测试硬约束（无 recommendation 字段 + 无建议措辞） |
| M8-4 | `runs forecast` 成本预演 | 🟢 工具域(bonus) | 历史中位数 ± 区间；无历史 insufficient_data。只算账不阻断发射 |
| M8-5 | integrator 节点 | 🔵 工具起草 | 拼初稿（collect 前驱 text + 去重 + 拓扑序），completed:true 但不判交付质量——Lead 终验拍板 |

**关键设计决策**（用户理念固化）：
- **诊断不处方**：工具帮 Lead 快速定位故障类别（401/超时/scorecard fail/crash/abort），但"下一步做什么"由 Lead 实机判断，避免机械应对被 corner case 捅刀。
- **整合是初稿不是验收**：integrator 只省"手动 collect + 拼接"，交付质量仍 Lead 一眼审。
- **不做的**（防范围蔓延）：自动任务拆解成 DAG / 自动故障应对策略表 / auditor 自动串 DAG——这三项把高语义判断固化成机械流程，违背 thin-control-plane 原则，明确否决。

**测试**：536 → **571 tests pass**（+35 新增：5 M8-1 + 8 M8-2 + 11 M8-3 + 6 M8-4 + 5 M8-5）。docs-consistency +2 守卫防回归。技术债 TD-48（dashboard 全量读 transcript 性能，🟡 开放）/ TD-50（diagnosis 启发式分类，⚪ 刻意设计约束）。详见 `docs/roadmap.md` M8 行。

### M8-C：诊断扩充（按 B 冒烟发现，2026-06-26）

B 用真实 101 个 transcript 冒烟 `runs diagnose`，暴露两个真实失败模式的诊断盲区，本轮按发现扩充（TDD red-green）：

- **C1 新增 crash 覆盖 wait-phase**：真实 run `process exited with code 143`（SIGTERM，被外部信号杀死）此前漏到 unknown。crash 分支扩展为同时匹配 spawn/spawn_fail phase 与 `process exited with code N`（N≠0，含 143=SIGTERM/137=SIGKILL/130=SIGINT/1=通用），证据点出退出码 + 信号名。
- **C2 收紧 AUTH_SIGNAL + 新增 config_conflict**：真实 run `connectors are disabled because ANTHROPIC_API_KEY...takes precedence` 此前被宽泛 AUTH_SIGNAL（含裸 `auth.*fail`/`api_key`）误判为 provider_auth——但这不是 401 认证失败，是配置层冲突（API key 与 claude.ai 登录打架）。AUTH_SIGNAL 收紧为 `401|身份验证|unauthor|invalid...key`；新增 config_conflict（`precedence|connectors disabled|auth source`），排在 provider_auth 之前判。两者归类不同、Lead 处置方式不同。

验证：两个盲区 run 重跑——unknown→crash（证据含 SIGTERM）、误判→config_conflict（证据完整保留 stderr 原文，但诊断仍不给处方，铁律守住）。578/578 tests pass（571 + C 新增 5 + 铁律样本补 2 类别）。
