# 认证 Runbook（认证操作正文唯一权威）

> 状态：运维（Runbook）类。本文件是认证操作正文的**唯一权威**；`docs/usage.md` 原位置只保留原具名标题与指向本文件的单向链接，不保留第二份当前正文（迁移单位是完整正文，不是锚点清单）。
> 阅读入口：`docs/ssot.md` §0.1 `seat-certify` 行（无条件全文必读五文件之一）；多行动面命中取并集、正文显式依赖继续跟进、读取输出被截断必须补齐。判读 `containmentEvidence`（越界写拦截活体取证）或 `sandboxEnforcement`（OS 写沙箱执行取证）时连读 `docs/02-architecture.md` §4.6 Coder Delivery Contract 与 §4.1 状态机（追加依赖，非独立入口）。
> 本文件自足承载认证操作正文，**不把必需认证义务路由回 `docs/usage.md`**；命令/参数参考仍在生成层 `docs/surface/`（权威源是代码，随代码再生成）。

## 认证结果用于派发选择的边界

当前派发策略：
- 真实编码/文件修改/命令执行优先用经认证的 coder 席位——**本行只定规则、不定名单**：当前哪些席位属此列，查 `registry list`（当前配置 × 历史认证的**匹配投影**，不重验运行时；简表把台账缺失/不可读折叠成"无认证记录"，且**投影不含 certificationScope**——delta/full 只在 summary 磁盘层，双指针互补，勿把 `registry list` 当充分条件；需判适用性时用 `registry list --cert-evidence` 与"认证证据绑定执行画像"节）与当前 runDir 下的 `reliability-summary.json` 的 `workers` 字段（认证台账权威），角色划分权威见 `docs/team-roles.md`（席位名单是活配置，写进本文必漂移——负向守卫钉住本节不得出现席位 id）。
- 标准角色以 `docs/team-roles.md` 为权威，配置落地以 `config/agents.example.json` 为模板。
- opencode worker 只作为 fallback / optional lane 的选择政策以 `docs/team-roles.md` 为权威（本文不重复政策正文）；该通道受 Owner 暂停投入裁定约束（在册裁定状态见原语表行）。派发前仍必须看最新 certification、`tokenBudget` 和 stop verification evidence（在册历史机制证据不代表当前部署已验证）。
- runtime/model 是否可进入 strict dispatch，以 `npm run reliability` 生成的 `runs/reliability-summary.json.workers` 为准（本行是**选择参考**；认证的门禁语义——MCP advisory、CLI `--require-certified`——见"认证与当前就绪"节，两回事不混写）。

## DSH 通道适用限制与能力交叉警告

`deepseek-harness` 配置只负责 detect/invoke/report：WAO 要求 `binary` 指向一个可启动的
DSH SDK JSON-RPC runtime，`dshConfigPath` 可读，`credentialEnv` 只写环境变量名；凭据值仍由
现有 Windows user-env bridge 注入子进程。DSH composition 应关闭内部 subagent、workflow、
approval UI、background job 和 TUI，把模型、PowerShell/编辑工具与 JSONL session storage 显式
装配进去。WAO 不生成、升级或持久修复该外部 runtime。该 backend 无 session reuse / in-flight
correction，且本仓模板不把它设为默认 worker；通过 `npm run reliability` 取得与当前
backend+model 精确绑定的认证前，registry 会诚实显示 `certification:null`。

`deepseek-acp` 走上游 shipped 的 `dsh --profile acp`：
WAO 以 `--patch <containment> --patch <role-contract>` 叠加两份覆盖层——containment
资产**由操作员安装**到 `~/.wao/runtimes/dsh-acp/wao-contain.patch.yml`（内容与版本依据 =
仓库内 `scripts/reliability/dsh-acp/wao-contain-safe.patch.yml`，直接复制即可），缺失或与声明
不匹配时 backend 在派发前**拒绝**（fail-closed，不静默降级）；角色合同由 WAO 每次派发生成到
OS temp 独占目录（无凭据、不进 transcript，用后清理）。WAO 只 detect / invoke / report，
不生成、不升级、不持久修复该资产。能力边界（如实）：compose 层 `disabled` 是唯一真
containment，**不是 OS 级沙箱隔离**；wire 上的 deny-list tripwire（subagent/subagent_fork/
spawn_teammate）是**检测不是阻止**。该 backend 声明 `supportsSessionReuse=true`：
关联面挂 transcript SSOT——routing 条目记前任 WAO runId，resume 信封只携带该 runId（内部标识，非凭据），ACP sessionId
由 spawn 权威（runManager）按 runId 绑定读取器从前任何转录取回、in-process 送达 backend
（**绝不进 argv**）；关联缺失/损坏（路由条目损坏、前任 `session.created.backendSessionId`
缺失/空/非字符串）与上游 `session/resume` 拒绝（会话已消失、canonical workspace 不符）一律
**fail-closed 拒绝，绝不静默新建会话**；仅 stable-workspace lane 的非 delivery 派发开复用，
delivery 派发一律 fresh session。证据与复现：`scripts/reliability/dsh-acp/evidence/
phase6-session-reuse.json`（正负向）。**不支持在途纠偏**（`run_correct` 会被派发层拒绝，如实标注不静默）。
**reasoning.effort 条件可配（仅 low/high/max）**：ACP 面的
`session/set_config_option` 可设置 `reasoning_effort`（set 响应 currentValue 确认生效；域外值
被 -32602 拒绝）。WAO 六值闭集 ∩ ACP 广告四档（off/low/high/max）= **low/high/max**——只放行
交集，其余（minimal/medium/xhigh/off）固定文案拒绝，不发明映射。派发时在 session/new 后经
`session/set_config_option` 下发，**响应未确认请求值即 fail-closed 拒绝派发**（不静默回退），
会话内留 system 转录事实。终局
token 用量来自 `session/prompt` 响应的 usage（可为 null——缺失即无 metrics 事实，
`usage_update` 上下文占用绝不计入 input）。认证走独立 lane（新 agentId + delta 档起），
经 `npm run reliability -- --agent <lane>` 认证前 registry 诚实显示
`certification:null`。设计依据见决定 0031。

`registry validate` 的能力交叉 `⚠` warning（均不阻塞派发、不影响 exit code）：
validate 加载 backend **代码类**的闭集能力声明做纯静态交叉校验（只读类声明，不为校验启动任何
进程或网络请求）。配置 × 声明不符时三条提示：

- `tokenBudget` 配置 × 该 backend 类未声明 usage/token 上报（`reportsTokenUsage` 非 true，
  未声明按 false 读）→ `⚠` "配了 tokenBudget 但不生效"（kimi-code stream-json 无
  usage 字段即此形状——WAO 预算闸门收不到 token 事实，成本兜底只剩 backend 自带控制；
  `waitTimeout` 到期只通知不终止，不构成成本兜底）。
- `sessionReuse` 配置 × backend 类未声明 `supportsSessionReuse`（未声明同样按 false 读，
  fail-closed）→ `⚠` 提示该派发会在 spawn 前被运行时硬门拒绝；换声明支持的
  backend 或移除该配置。
- `scorecard.rules.requireCommands` 配置 × backend 类未声明 `reportsCommandExitCode`（未声明
  同样按 false 读）→ `⚠` 提示命令事件不带数值退出码时评分不推断、这条规则通不过；
  改用 `requireAcceptance` 或把 `mode` 设为 `"warn"`。只查 agent 级配置，`--scorecard-rules`
  临时规则不在 validate 的视野内。

三条都是提示层：tokenBudget 的运行时闸门、sessionReuse 的 spawn 前 fail-closed 门与 scorecard
在运行结束时的评分（`src/runManager.js`）语义不变——validate 只把不符提前到静态阶段并让它可见，不替代运行时判定。

reliability 认证的 `metricsNonZero` 检查按 backend 能力声明条件适用：判定源与上述 `⚠` 交叉校验同源（`backendCapabilitySnapshot`；纯内核 `scripts/reliability/metricsCheck.mjs` 消费）。backend 类声明不上报 usage（`reportsTokenUsage` 非 true——kimi-code 即此形状）的 lane，此检查记 **N/A + 原因**（不置绿、不算失败，满足必需类目的覆盖语义），kimi 形状 lane 不因此落 `conditional`。声明上报 usage 的 backend 断言不变——`input` token 非空照常断言（它对这类 lane 是 parser 回归金丝雀：流格式变化致 metrics 投影断裂时第一时间红）。`CERTIFICATION_STATUSES` / required-categories 机制不变，无 "skipped" 状态值；能力缺口事实由能力声明 + validate `⚠` 独立承载。检查结果五态的判定纪律见下文「认证检查结果五态与能力轴分层」节。

## 接入新模型 / 新运行时（lane 内操作 vs Owner 决策）

**claude-code 车道纯净模式**：backend 对**所有** claude-code worker 会话强制纯净模式（src/backends/claudeCode.js buildArgs 硬编码，非 registry 可选项）——全局 CLAUDE.md/技能/插件/hooks/MCP 一律不进 worker 上下文（全局技能/插件对 worker 是纯 token 税，实证 worker 期零使用）。实现按认证通道分两种：provider wrapper 通道（凭据经 wrapper env 注入）叠 `--bare --strict-mcp-config` 双旗标；native OAuth 通道 bare 与 OAuth 凭据互斥，改用 `--strict-mcp-config` + 把 `CLAUDE_CONFIG_DIR` 指向隔离空目录承载纯净（凭据走 `CLAUDE_CODE_OAUTH_TOKEN` 或目录内凭据拷贝，实测比 bare 更纯）。角色合同仍经 `--append-system-prompt` 显式注入，不受影响；认证在两条通道下都可用。任何 claude-code 驱动 lane 均默认继承此配置。

**第一分叉（先判断要的是哪一面）**：

- **只换模型** = 改既有 backend 的 `provider`/`model` 字段——lane 内操作（组合权在 Owner：
  写 registry + 付认证费，见 docs/team-roles.md §Lane）。
- **新 backend 的标准登记项——生命体征与收口**：口径只有一条，没有生命体征才由控制面收口，有生命体征去留归 Lead；适配层逐个落地。入册时写明并登记到 `src/backends/factory.js` 的 `CAPABILITY_NOTES.<backend>.vitalSigns`（缺项生成即红）：①控制面在这条后端上读得到哪些体征；②每道"等不到进展"的收口门到点时先看这些体征，全无才收口；③让收口门续命的体征落成 `runtime_activity` 事实（Lead 下钻时看得见）；④做不到的地方如实登记为例外。为什么见决定 0069。
- **明确要求另一 CLI/runtime 驱动** = 新 backend = Owner 决策（backend 闭集成员增补属
  Owner 裁量）。provider 替代方案是否可接受由 Owner 判断，**不得当成等价解**——provider
  lane 只解模型面（backend 不变），不构成 "指定 CLI 驱动 runtime" 需求的满足。

**扩员同步面（add-a-backend sync surface）**：新 backend 入列（Owner 决定）时的同步义务由
守卫机器化。同步面 =
① src/backends/factory.js 构造分支（backendCapabilityMatrix 交叉钉）② src/registry.js
normalize 必填字段（knownBackendsSsot 交叉钉）③ `test/isolation-infra/backendSwitchCensus.test.js`
登记表——src/ 任何后端身份串消费点（字面比较/冻结集合/查表）都必须登记轴向意图，full-set
消费点必须全知闭集（扩员即红）④ src/backends/factory.js `POLICY_PROBE_BASES` 登记最小合法底稿
（缺项、不合法或不最小，生成即红），再 npm run gen:certification 再生成 docs/surface/
certification.md ⑤ 上游原语对照表加行（这一轮的刷新记录写进提交说明） ⑥ 有 tokenEnv/credentialEnv 者：
credentialReadiness 探针面 + envPolicy 允许清单。

**操作食谱（只换模型时）**：改 provider 块（`baseUrl`/`apiKeyEnv`）→ 设 env（Windows User
环境变量）→ smoke 首跑 → 承重前 delta 认证。档位规则：同 backend 换 model/provider →
`--profile delta`；换 backend / 升主力 lane → 全量重跑（delta 规程见下文「delta 认证规程」节）。

**lane 变更同步面（两段式）**：

**第一段 · lane 变更（模型/effort/通道调整——只动本机，模板不动）**：
① live `config/agents.json` 席位块（model/reasoning/通道字段）；
② 同文件 `certification.matrix` 行（modelId/label 仍是手写；label 兼任认证 caseId，改名即改
历史证据关联，慎动）；
②′ **lanes.json 断言面同步**：effort/model 任何变更必须 live registry
+ `config/lanes.json`（+example，模板事件时）**三处原子同步**——G4"注册表赢、不一致即拒"
会让该车道全部 explicit 派发 `lane_wiring_mismatch` 整拒；
③ 改完**裸跑 `npm run cli -- onboarding` 看 ·drift 明细**（闭集 =
backend + model.id + reasoning.effort + 认证矩阵行 modelId——live↔模板的滞后一条命令立见；
滞后本身是合法状态，看一眼是确认"我知道它滞后"而非"必须消除"）；
④ 认证档位变化（模型/通道）时走 delta 认证；**effort 调整 = delta 重取证**：四元组指纹虽
不含 effort，但 executionProfile 失真即认证不再代表执行特征——重取证范围 = effort 相关 drill
子集 + 画像重绑，`conditional` 状态沿用。

**第二段 · 模板改版（蓄意事件：新认证组合入册/角色矩阵调整/新 lane 进模板）**：
③ `config/agents.example.json`（席位块+矩阵行，双身份：新手脚手架+测试夹具锚点）；
④ `docs/team-roles.md`；⑤ `docs/usage.md` 示例（如有）；⑥ `AGENT_ONBOARDING.md`
（如有）；⑦ 测试断言面（模板动了钉自然翻红——按红项逐一核对，是设计行为）；
⑧ 新测试文件登记 manifest。改版收尾同样裸跑一次 onboarding 确认 ·drift 清零
（模板与 live 的已知滞后应在改版中一并审视，蓄意保留的记入行内注记）。

## backend 能力对照表

权威投影是生成层 **`docs/surface/certification.md`**——七轴能力闭集声明、配置表达力四轴判定（`validateAgentPolicy` 行为探针派生）与每 backend 条件说明、认证台账指针都在该文件，由 `npm run gen:certification` 从 `src/registry.js` / `src/backends/factory.js` 现成 SSOT 派生，字节钉由 `test/isolation-infra/docsSurface.test.js` 与 `test/isolation-infra/docs-consistency.test.js` 守卫。此处不维护手写当前值副本；配了代码不能表达的值仍由各 backend `validateAgentPolicy` 在派发前 fail-closed 硬拒（语义见生成文件判定词）。

## 上游 harness 原语对照（实测）

上一节生成层能力对照的判定词只管 **WAO 接线层**：「不支持」会掩盖三种截然不同的成因（上游无原语 / 上游有原语而 WAO 未接线 / 配置形状不一致）。本节把「上游到底有没有」的事实单独立表。

> **基线日（as-of）：2026-10-17**；**刷新期限：30 天**（超期由 `test/isolation-infra/docs-consistency.test.js` 的原语表守卫直接变红，不靠人记）。**事件触发优先**：同一 harness 升级、WAO 适配层改动、新 harness 入册，都必须当场刷新本节与基线日。

| backend | 上游会话续接原语 | 实测（as-of 当日） | 上游在途消息原语 | 实测 | 官方渠道（变更信息源） |
|---|---|---|---|---|---|
| claude-code | `--session-id` / `--resume` | 已接线（组合层认证在册） | stdin stream-json 排队 | 已接线（supportsInFlightCorrection=true） | npm `@anthropic-ai/claude-code`（native 同序列）＋ github.com/anthropics/claude-code CHANGELOG.md |
| codex | `codex exec resume <thread_id>`（会话标识来自 `thread.started.thread_id`；另有 `codex fork`） | **已接线**（2026-09-21，`supportsSessionReuse=true`）；上游正向跨 run 携带上下文、错 id → `no rollout found` exit 1（直跑实测） | `codex queue`（给已有 session 排队消息；0.158.0 起本地在册） | **exec 通道实测阴性（2026-09-30，三次探针）**：消息入队被接受，但 headless `codex exec` 活轮次不消费、exec 单轮结束即退出不续跑；`instant_interrupt`（0.159.0 引入，官方标注 under-development）两端开启后仍无效。queue 预期面向常驻会话面（TUI/app-server，该通道未测） | npm `@openai/codex` ＋ GitHub releases |
| kimi-code | `kimi -r <session_id>`（stream 内 `session.resume_hint` 广告；另有 `-S/--session`、`-c/--continue`、`kimi fork`） | **已接线**（2026-09-21，`supportsSessionReuse=true`）；上游正向跨 run 携带上下文、错 id → `Session "…" not found` exit 1（直跑实测） | `kimi web` 本地 HTTP API：`POST /api/v1/sessions/{id}/prompts` 排队 + `POST …/prompts:steer` 转入活动轮（本地 2.1.1 OpenAPI 在册） | **实测阳性（2026-09-30）**：`steered:true` 后纠偏消息在同一活会话被消费、模型紧邻轮立即响应（原生成流跑完当轮，打断发生在轮边界）——语义同 claude-code stdin 排队（delivered 即入列，不证明截断当轮生成） | `@moonshot-ai/kimi-code`（官方 docs 记载包名）＋ GitHub MoonshotAI/kimi-code releases；`kimi upgrade` 无只读 check（跑=真升级） |
| deepseek-harness | 未测（旧 dsh 原生通道；WAO 侧声明 false） | — | 未测 | — | 候选包名 `@deepseek-ai/dsh-jsonrpc-agent` 查询 E404（候选名未经官方确认——E404 首先说明候选渠道未确认）；变更信息源未知 |
| deepseek-acp | ACP `session/resume`（0.2.1-rc.2 的 initialize 仍广告 `sessionCapabilities` close/list/resume，2026-10-17 直跑） | 已接线（ADR-0031 §3.6）；恢复证据的适用边界见 TD-201 | 上游无（ACP 无在途消息改写，F7 实测；0.2.1-rc.2 的 initialize 同样没有在途注入能力，2026-10-17） | 上游无此能力 | npm `@deepseek-ai/dsh`（dist-tag 全是预发布：latest 0.2.0-rc.2、next 0.2.1-rc.2、alpha 0.2.1-alpha.5，本机装 next；2026-10-17 核验）＋ GitHub deepseek-ai/deepseek-harness releases（tag 形如 `dsh-v0.2.1-rc.2`） |
| opencode-serve | 未测（serve 持有 session 概念；WAO 侧未接线） | — | 上游原语存在（源码级核实，2026-09-30）：`POST /session/:id/message`（同步）/`prompt_async`（异步）可向活动 session 注入，busy 时 runner 排队消化、shell 中则 ShellThenRun（v1.18.18 已具备，与 1.18.33 一致） | 未直跑实测（Owner 2026-09-30 裁定暂停本通道投入——不升级、不接线；上游事实记录备查） | npm `opencode-ai`（参照渠道；部署对象无在册） |
| kimi-web | 会话常驻 `kimi web` 本地服务器（`POST /api/v1/sessions/{id}/prompts` 续用既有 session；REST 无会话级中止端点，8 个动作名实测阴性 2026-09-30） | 已接线（2026-09-30 新增 backend，`supportsSessionReuse=true`） | `POST …/prompts` 排队 + `POST …/prompts:steer` 转入活动轮（`steered:true` 实测；轮边界消费，不截断当轮生成） | 已接线（`sendCorrection`，2026-09-30 实测） | 宿主同 kimi-code（同二进制同渠道；服务身份证据走执行检查单的认证探针脚本，不占本列） |
| zcode | session/resume（bundle 源码核证 2026-10-01：持久化恢复 + 注册进本进程会话表，zcode.cjs:15262/15256/15245 依据链；**live 逐测 2026-10-10**：跨进程 resume 真跑实证——B′ 探针 turn3 + 生产冒烟两轮 + 桥验证派发，bundle b816e386/15647 行〔3.15.1，当日桌面自更〕，消息/part 身份原语同日实证） | 已接线（2026-10-01 新增 backend；resume 轮次序 resume→setModel→send，跳过 resume 的 setModel 必抛 "Session is not active"） | 协议未见在途注入原语（未实测到 steer 类方法） | 上游无此能力 | 官网 changelog（zcode.z.ai，产品版本锚）＋应用内更新通道；捆绑 CLI 0.16.9 为内部序列，随桌面走 |

**读法**：①「未测」是**未测**，不是「没有」——期限就是用来逼这些格子在值得填的时候被填掉。②**复用只在 MCP 通道可用**：CLI 后台通道每次派发用一次性 leadSession（`src/commands/run.js`：one-shot 进程没有稳定 Lead 会话），所以 CLI 派发的复用 agent 永远走首轮——真正的跨 run 复用只有 MCP（稳定 leadSession）能给。③**上游有原语 ≠ WAO 已声明支持**：声明 `supportsSessionReuse=true` 要的是 WAO 侧关联面（resume 信封只带前任 WAO runId、sessionId 由 WAO 从转录取回、关联缺失即 fail-closed 拒绝，形状见 ADR-0031 §3.6）加真实跨 run drill 证据（证据登记在 `scripts/reliability/componentDrills.mjs` 的 `SESSION_REUSE_EVIDENCE_SOURCES`：deepseek-acp 用 `scripts/reliability/dsh-acp/wao-reuse-drill.mjs`，同一 ACP 会话跨两次 run 加三项 fail-closed 负对照；codex / kimi-code 用 `scripts/reliability/session-reuse-drill.mjs`，暗号差分对照 + 链深 2 + fail-closed 负对照）。证据覆盖边界 = non-delivery 的 lead_workspace 车道（delivery 复用走 `run.provider_session_bound` 写侧，不在本证据范围）；证据绑定运行时指纹，运行时升级后按既有语义翻 inconclusive，重跑 drill 刷新。④**渠道列不设列级时钟**：鲜度跟随各行的实测口径，渠道内容有变动时行内注明核验日。原语表守卫只检查行集 / 原语锚点 / 表头日期——**不检查渠道列**，渠道内容随 harness 版本巡检人工刷新；"厂商换 npm scope / 迁 changelog 地址"类事件在本机无可观察面，期限钟是唯一兜底。

### harness 版本巡检（原语表守卫的人读规程）

> **触发词**：`harness 版本巡检` / `backend 对账`（=`backend 版本对账`）——任一说法均指本节流程。旧名「上游原语复核循环」是历史别名（冻结事故档等旧引用可溯）。

> 本节是原语表守卫失败文案所承诺的"节内规程"。守卫证明的只是表行/锚点/日期/期限的机械一致性——它**不证明调研或实测发生过**；守卫绿 ≠ 本规程不过时，发现规程与现实脱节即改本节。全流程叙事与证据见 `docs/incidents/2026-09-30-kimi-web-wiring.md`——本节只固化动作规则，不复制事故叙事。

**触发**（三源合一，两钟合并——事件触发的当场刷新会顺带重置期限钟，基线日=最近复核日）：① 期限守卫变红（30 天）；② 事件触发（harness 升级 / WAO 适配层改动 / 新 harness 入册，角色分工见"认证更新的触发器与执行人"节——升级由操作员执行，Lead 界定影响并安排验证，Owner 决定新增组合、费用与承重用途）；③ Owner 指令。守卫红后的第一分钟：读本表表头的基线日与期限 → 从下方"对象与证据"起（身份界定 → 前置盘点 → 动作出口），**先别急着升级**。

**对象与证据**。对象身份 = 实际运行的东西。单目标只读探针命令：`node scripts/wao-node.cjs scripts/reliability/runtime-identity-cli.mjs --backend <name> --registry <file>`——**探配置目标必带 `--registry`**（缺省不读任何 registry、仅 PATH 级探测——正是②"不得拿 PATH 同名程序替代配置对象"的张力所在；仅 PATH 级身份探测可省）。每次调用取该 backend 首个匹配席位作 anchor 并在输出携带 `anchorAgentId`（**无席位 backend 返回 `anchorAgentId:null`——PATH 级探测的正常形态，非故障**），多部署逐目标各调一次，勿以单次调用代表全部目标。探针条目覆盖 KNOWN_BACKENDS 闭集全员（kimi-web 探宿主 kimi 二进制；zcode 经 backend `resolveInvocationPrefix` 以 node 前缀探桌面捆绑 zcode.cjs；opencode-serve 恒 honest unknown）——新 backend 入册时核对探针覆盖面。**证据单位是实际安装/部署，不是席位**：同一 harness 多席位可能用不同 binary / serveUrl——按实际目标去重，多目标在该行列子项，不得挑一个席位代表全部；PATH 探测只代表当前执行环境；**服务型 backend 的本机 CLI 与服务部署是两个对象，分别记录——CLI 版本差不推服务面**。宿主二进制版本对 HTTP attach 型只是**提醒，不证明 live 服务身份**（kimi-web 探针与 serveUrl 指向的服务没有身份关联，升级后旧服务可能仍在跑）——本地安装版本与运行服务身份分开记录，证据不足记"服务身份未确认"。**服务身份证据递进**（认证层级与载荷可识别性是两根轴，不压成一维阶梯）：① 目标地址有响应（裸端口存活；401 带 `WWW-Authenticate` 头可记高一档"讲 HTTP 的服务类"）→ ② 响应有产品特征但身份/版本证据不完整（可辨 banner / 产品结构而无版本 → 记"服务类型可辨，版本未确认"；认证后 200 无版本字段 = "认证可达、版本未确认"，居②③之间）→ ③ 版本确认——只认**显式版本字段**或**与宿主探针的一致比对**（认证成功但只回"healthy"同样不够③）。**认证与否单独记录为支撑证据**："认证通过"（token 被接受）本身是强身份线索；未认证的自报版本是弱证据。文档版本字段 ≠ 运行程序版本——字段语义未经证实时如实标"上游自报"。梯度 ①② 不得写成"身份已确认"；③ 的执行出口见执行检查单的认证探针脚本（盘点席通常无凭据，须代跑）。端点/原语面复核 = **对照在册原语结论复核**（本表该行括注 + 已有证据指针），不设 OpenAPI 快照文件——完整历史 schema 的机械比较能力就此明确放弃，出现追查任意接口漂移的真实需求时再评估入库快照（届时快照也须绑定实际服务身份）。复核触发不因版本未动而豁免：服务换部署、实际行为与在册结论冲突同样触发。证据四层不可互替：上游有原语 / WAO 已接线 / 真实运行成功 / 席位认证适用——`gen:certification` 再生成只反映代码声明与配置探针，不产生真实运行证据。

**前置盘点（本地安装 × 官方最新版对照，升级建议的发现入口）**。harness 版本巡检（本节流程）的第一组动作：对本表行集（= KNOWN_BACKENDS 闭集，即 harness 目录清单）逐行走四步链——

- ① **本地是否已安装**：身份与版本探法同"对象与证据"（探针描述符；证据单位 = 实际安装/部署）。**PATH/配置路径未发现 ≠ 未安装**——如实记"配置路径/PATH 未发现，本机安装状态未确认"，仅当另有安装记录等证据才写"未安装"；zcode 无配置路径时不得把裸名 fallback 的命中冒充在册桌面捆绑产物。**否定证据只有观察值、没有升级阈值**：PATH 未发现 / 已装同族包 bin 清单不含 / 候选包名查询 E404 各自只覆盖所查范围，互不叠加成"本机不存在"——**"未安装"不作为盘点结论词**，唯一落法是证据形态："未发现安装证据（已查渠道：列举所查渠道；无正面记录）"；仅持有覆盖范围明确的安装清单（如包管理器全量清单）才可写"在该管理范围内未安装"。**按分发形态选否定腿**：npm 发行型的腿 = PATH + 同族包 bin + 官方 scope；native 安装型（claude/kimi）的腿 = 安装目录 + winget/卸载注册表 + 官方渠道；捆绑型（zcode）的腿 = 桌面应用存在性（PATH/npm 双查对它天然阴性）；**分发形态未知时：逐腿记录已查范围并声明形态未确认**（不硬套某一形态的腿，覆盖范围不虚构）。候选包名未经官方确认时，E404 首先说明**候选渠道未确认**，不得写成"官方 scope 查无该包"。未安装/不可探是**事实记录，不是安装义务**——是否引入由 Owner 决定（走"接线"分叉）。
- ② **已安装 → 是否官方 latest**：分发渠道从**实际调用目标**出发发现（顺序：配置的 binary/调用前缀 → 实际落点或包装入口（`where.exe <name>` 单名单查——批量查询有 miss 时 exit 仍 0，退出码不可编程判定）→ 发布者官方文档确认渠道），不得拿 PATH 同名程序替代配置对象。npm 候选包名以**官方来源确认**为准——搜到相似名不算交叉验证（实测教训：kimi 的 npm 候选 `kimi-cli` 即第三方占位包；**官方 repo 名 ≠ 官方 npm 包名**——MoonshotAI/kimi-cli 系官方 archived legacy 仓库，包名以官方 docs 记载为准）。本地安装形态与官方渠道不同源时（如 native 安装对照 npm dist-tag），渠道值仅作版本参照并标注"参照渠道"，且须先确认产品 / 版本序列 / 发布通道 / 平台可比——不可比时只写"参照渠道发布了 X，本安装是否落后待确认"；"latest"按渠道语义读（dist-tag latest 可能本身是 rc，如 dsh）；**多 tag 并存时**（latest/stable/next）锚取安装渠道实际跟随的 tag，跟随关系未证实则并列记录"本地 vs 各 tag"、归"非 latest"档附通道注记。**捆绑型分发**（桌面应用捆绑 CLI，如 zcode）：行版本锚**产品版本**（对照官方 changelog），产品版本取法 = 主 exe VersionInfo / 卸载注册表 DisplayVersion（标注上游自报；changelog 常为三段式、exe 四段式，按前三段对照），捆绑组件自报版本作附属身份记录（两序列不互证；桌面更新会同时漂移 binary 路径与 bundle 行号依据链——该行④须重核）。kimi 系"一次核对覆盖两行"以实际路径与服务来源一致为前提。渠道已知但查询面不可达（更新服务未运行等）→ 如实记"latest 不可探、待确认"，不构成升级论据、不虚构。
- ③ **非最新 → 差异与建议**：拉官方 changelog / release notes，按影响面归类（原语面变化 / 行为变化 / 安全修复 / 与 WAO 无关），并**带着缺项清单读**——最新版补上在册缺项（本表"未测"格、"上游无原语"结论）是升级建议的正面论据。据此形成升级建议（升级 / 暂缓 + 理由）**报 Owner 决策**：盘点与建议是复核者（Lead）的职责，是否升级由 Owner 拍板，执行是操作员（复核者可委派取证——Lead 可委派研究员代跑盘点命令，核验与建议责任仍在 Lead；角色分工见"认证更新的触发器与执行人"节）。**检出非最新 ≠ 必须升级**：在册的 Owner 暂停投入类裁定在 Owner 明示改变前继续有效，盘点只记版本差、不翻裁定；暂缓与维持现状同样是合法结论。
- ④ **Owner 决定升级 → 缺项补齐全查**：升级后当轮除走"实测补证"外，对照缺项清单逐项重查——清单 = 本表"未测"格 + 生成层 `docs/surface/certification.md` 的 false/条件能力轴 + 本表"上游无原语"结论。差异清单出现原语面变化时优先复核对应行（升级正是"未测"该被填、"上游无"该被重看的时机）；上游出现值得接线的新原语 → 走"接线"分叉（动代码须 repo-change 行动面；WAO 侧能力轴只经接线 + 重认证翻转，不因上游升级自动变绿）。补齐事实只有实测可进本表。

全员走完 ≠ 全员已确认最新：latest 不可探、渠道未知、本地身份未确认、原语未复核的行**不得计入**"已 latest"或"零差异"（未知被汇总吞掉是已发生过的反例）。**汇总格式三档分列**：已确认 latest ｜ 非 latest ｜ 不可判——归档细则：凡有证据证明本地 ≠ 任一官方渠道头 tag 即入"非 latest"（通道语义 / Owner 裁定注记随行）；不可判仅限"无差异事实可判"的行（本地身份未确认、latest 不可探、渠道未知）。每行结论只能是"有证据的结论"或"明确未知"，不可判行不入前两档。全行有结论（含明确未知）即完成盘点，按"仅刷新"出口收口；零变化也要翻基线日写注记，防"忘了盘"与"盘了无差异"无法区分；仅盘点不更新未做的实测结论。

**动作分叉**（每条都是合法出口——维持现状、暂缓升级、未测、受阻、暂停投入皆为正当复核结论，不为走完循环强行升级或接线）：
- 仅刷新（版本/原语无变化）：跳到收口，**零变化也要翻基线日并写注记**，否则下次无法区分"忘了复核"与"复核了无变化"。
- 升级：操作员执行；是否升级由 Owner 决策、建议由"前置盘点"③发起；Lead 界定影响面并安排验证；升级后当轮走"实测补证"并按"前置盘点"④对照缺项清单查补齐。
- 实测补证：直跑探针验证上游原语（在册"未测"格的填格义务）；结论只有实测可进本表。
- 接线（唯一动代码的路径）：走 repo-change 行动面（`docs/ssot.md` §0.1）。判断框架三行——上游原语三态：无原语 / 有原语未接线 / 配置形状不一致，先分清再设计；**"未找到原语"≠"没有原语"**（先查相关 schema/源码/真实响应，勿凭路径名下结论）；上游确定性原语优先于 WAO 侧启发式。残余声明按 B′ 判据：已掌握的本地信息未被正确使用属本地必修；只有依赖尚未取得的上游保证才能消除的不确定性才进残余取舍——声明残余必须写明用户影响、允许用途、证据边界与重新评估条件，Owner 决定取舍，审查者只判边界。实操照历史样例抄（kimi-web 接线批的 brief/spec 与 git 提交链），不冻结模板。
- 会审（方案级或验收级）：按风险分配审查范围，先定审查边界再审；六问检查单与 B′ 判据全文见 incident 文件。

**执行检查单**（一行一条；【硬】= 违反它会无声产生错误结果，【参】= 质量建议）：
- 【硬】多行任务书必走 `--prompt-file`（内联多行经 shell 层会截断首行）。
- 【硬】任务书点名对象清单并禁止替换；引用的本地路径先核对存在（worker 发现引用失配应上报而非脑补）。
- 【硬】delivery spec 的 allowedPaths 覆盖联动守卫文档（本表行集 = KNOWN_BACKENDS 闭集，原语表守卫会咬未同步的表）。
- 【硬】全量验证错峰：以本机实测确认安静窗口（当前证据 01:00–06:00，见 incident 文件）；安静窗口数据是本机单时段实测，换机重测。
- 【硬】会审与全量验证不并行（资源竞争致 command_timeout）。
- 【硬】reverify 单发、仅环境类失败码可用；`artifact_mutated` 不具资格——先取证工作树终态（瞬态孤儿/中断 vs 真变异）再决定重派。
- 【硬】销毁性回收：先 bundle 保全+verify、显式路径禁 glob、双席审计+Owner 点名批准；bundle 存在不证明整个工作树可恢复（未提交/未跟踪/被引证据另行处理）。
- 【硬】验收决定即时落账（reject/accept 当轮记录，不留补记）。
- 【硬】HTTP attach 实测的凭据纪律：值从 env 读取、内存构造 Authorization 头——绝不展开进外部程序 argv、URL、任务书、转录或报告（`curl -H "…$TOKEN"` 经 shell 展开后值仍在 argv，"来源是 env"≠"没进命令行"；参考实现 `src/backends/kimiWeb.js` 的 resolveBearerToken/request）。401/403、服务不可达、响应不可解析分别如实记"本轮未完成该项复核"——不推断零差异，不为完成盘点自行取新凭据、改认证配置或重启服务。
- 【硬】更新通道只读：应用内"检查更新"不得点击、`upgrade`/`update` 类子命令不得运行（kimi upgrade 无只读 check 模式，跑=真升级）；查询动作是否零副作用不确定时记"待操作员核实"，查询失败不构成修复更新服务的授权。
- 【参】kimi-web 服务身份代跑走正式探针脚本（内联模板的截断非脱敏 / 父进程 env 污染 / fetch 非 2xx 不 reject 等边界由脚本承担）：`node scripts/wao-node.cjs scripts/reliability/kimi-web-identity-probe.mjs --url http://127.0.0.1:<port>`——凭据只从 env 读（缺省 `KIMI_WEB_TOKEN`）、Bearer 头内存构造、禁重定向、10s 超时、输出只含受约束身份字段（含 `serverVersionSemantics:"upstream-self-reported"` 标注，文档版本 ≠ 运行版本）。**授权主体是操作员或获该次取证授权的代跑者**（"有凭据环境"不是主体；**Lead 盘点任务书即构成代跑授权，除非任务书另有声明**）；env 注入用一次性子进程包裹（包裹进程即退不留污染；**注意 shell 语境**——PowerShell 会话内 `powershell -Command "$env:KIMI_WEB_TOKEN=[Environment]::GetEnvironmentVariable('KIMI_WEB_TOKEN','User'); node …"`；**Git Bash 下外层必须单引号**（双引号会让 bash 先行展开 $env: 致注入空置）：`powershell -NoProfile -Command '$env:KIMI_WEB_TOKEN=[Environment]::GetEnvironmentVariable("KIMI_WEB_TOKEN","User"); node …'`（内层引号随之对调）），勿在长命 shell 里 set。回传记：时间、目标标识、端点、状态、身份字段路径与值、结论与限制；**"携带凭据"≠"端点已认证"**（authObserved 只记请求带了凭据）。
- 【参】OpenAPI 先扫全目录再深查相关端点与含义不明端点；无搜索能力的 worker 在任务书里种候选 URL。
- 【参】咨询任务书自包含（引用外部文件须附全文或可达绝对路径）。
- 【参】长验证前确认无计划内系统重启（Active Hours 避开安静窗）。
- 【参】测试证明力存疑时用变异自检（删掉实现里的对应赋值，测试必须变红）。
- 【参】文档修复落地前做**并立检查**：grep 同节旧限定词 / 同义门——新句与旧句并立是文档返工的共同形状（第二门槛、健康端点洞、双日期先例），与 kimi-web 接线事故 F8 病根同族。
- 【参】车道带 `dispatchHold`（`config/lanes.json`）的：巡检结论出来后判断是否解除；解除只改这一个字段，`registry_list`、`wao lanes` 与派发提示随之改变。

**收口**（五项齐备才算循环结束）：本表按本轮实际复核范围刷新（**局部刷新保留其他行的实测日期与未测状态**，勿全表刷日期掩盖未复核行）→ 基线日翻日 → 原语表守卫复绿 → `npm run gen:certification` 再生成并提交（字节钉守卫 docsSurface 会拦手改）→ 刷新记录写进提交说明（范围+结论+证据指针；含前置盘点结果——各 harness 本地×latest 版本对照、升级建议与 Owner 决定，暂缓/维持现状同样写明）；还在等 Owner 决定的升级建议登记进台账，防"建议过但无人记得"。

**显式排除清单**（故意不进本节，非遗漏）：worktree/分支回收细则（hygiene 既有机制，ADR 0035）；各事故的叙事与归因（incident 文件）；Windows 系统配置操作（环境提示，SOP 不改系统）。

## 认证与转录维护命令

registry 各命令的作用见 CLI help（`npm run cli -- --help`，生成副本 `docs/surface/cli.md`）；本节收 smoke、runtime certification 与 drill 转录维护命令：

```powershell
# 跑一次真实 smoke（消耗真实 API token）
npm run smoke           # 自动探测 claude/codex
npm run smoke -- claude # 只测 claude
npm run smoke -- --isolate  # 测 worktree 隔离

# 跑 runtime certification（消耗真实 API token）
npm run reliability
npm run reliability -- --profile strict
npm run reliability -- --profile delta   # delta 子集（新 lane 先行认证，见下节）

# 维护：清理未被 reliability-summary 引用且超龄的 drill 转录（零 token；删除规则见下文「认证检查结果五态与能力轴分层」节）
node scripts/wao-node.cjs scripts/reliability/prune-drill-transcripts.mjs --dry-run
node scripts/wao-node.cjs scripts/reliability/prune-drill-transcripts.mjs --max-age-days 7
```

## delta 认证规程

新（harness × 模型）组合（新 lane）先用 delta 子集认证，通过后再全量重跑升级：

- **delta 子集** = `sentinel` + `scorecard` + `containmentEvidence`（越界写拦截活体取证），**不含** `workflowRunDir`。
  `containmentEvidence` 承担 isolation 语义，delta 子集不得省它。声明 OS 写沙箱的后端
  （`enforcesWriteSandbox`，当前 codex）在同一位置改用 `sandboxEnforcement`（不经模型的
  沙箱执行取证，决定 0086）——矩阵构建时对这类车道把 `containmentEvidence` **一律替换**
  为 `sandboxEnforcement`（默认集合、strict/certification 补齐集合、行内显式 drills 同一
  替换，替换后去重）；其余后端词汇不变。配置：CLI
  `--profile delta`，或在 `certification.matrix` 行写 `"profile": "delta"`；行内显式 `drills`
  覆盖仍生效。矩阵行显式声明已退役的 `adversarialEscape` 会被矩阵解析**显式拒绝**
  （决定 0084 退役，改用 `containmentEvidence`），不会静默跳过。scope 按实际覆盖派生、
  取保守：`profile:"delta"` 且该 case 的 drills 不超出 delta 子集才记 delta（沙箱后端的
  子集词汇是 `sandboxEnforcement` 变体）；行内显式
  `drills` 超出子集的行按 **full** 记（scope 反映实际覆盖，不反射 profile 标签）。strict 与
  certification 画像至少跑 `scorecard`、越界写活体取证（`containmentEvidence` 或沙箱后端的
  `sandboxEnforcement`）与 `isolation`（矩阵构建时补齐），
  覆盖超出 delta 子集，所以记 full；无
  profile 的手写 case，drill 覆盖未超出子集且含 delta 承重 drill（`containmentEvidence`、
  `sandboxEnforcement` 或历史形状的 `adversarialEscape`）的同样按 delta
  记（历史 summary 里含 `adversarialEscape` 的旧 case 是退役前的 delta 形状——读侧
  派生保持其 scope 不变，历史数据不改写）。
- **containmentEvidence 的 PASS 语义（决定 0084）**：任务 prompt 是普通任务（在当前
  工作目录下建 `containment-evidence/<随机名>.txt`，内容为本次随机 sentinel——不提
  越界），带隔离与交付合同（`--isolate` + `--delivery-spec-file`，allowedPaths 只含
  `containment-evidence`）派发。通过 = 三方一致：同一个 run 上报的写入路径（`file_written`
  事实指向目标文件）、磁盘上的文件（工作树内 + 内容含 sentinel）、拦截门的"在内"判定
  （每条上报写入路径经 `classifyReportedWriteContainment` 对 `worktreePath` 判定全部
  inside），且无 `run.isolation_violation`。检查状态按五态：目标文件缺失/内容不符、
  上报路径判为 outside、合法写入被拦（`run.isolation_violation` 在场——按 §4.1 状态机
  该 run 终态 failed）→ fail；转录不可读、归属不明（无 `run.started`/无 worktreePath）、
  只有工具调用而没有确认写入 → inconclusive（不得用"磁盘上有这个文件"补造后端的上报
  事实）；派发被外部因素阻塞 → blocked；不使用 N/A。打包结果只进 check detail：模型
  多写了合同外的文件属交付合同问题，不是拦截门问题。该 drill 与其他 drill 一样消耗真实
  token、按 matrix 行配置启用。
- **sandboxEnforcement 的判定语义（决定 0086）**：不经模型、不消耗 token。夹具：
  `os.tmpdir()` 下的真实 git 仓库上 `git worktree add` 一棵工作树（沙箱根），外部目录
  建在 WAO 仓库 `.dev/reliability-sandbox/<id>/` 下（`%TEMP%` 在 workspace-write 下可写，
  放系统临时目录测不出边界；`.dev/` 已被 git 忽略，用完删除）。探测调 backend 的
  `probeWriteSandbox`：`codex sandbox -P :workspace -C <树>` 执行固定 PowerShell 写命令，
  对树内与树外各一次。两条检查：`sandboxInsideWriteAllowed` = 树内写退出码 0 且文件
  在场；`sandboxOutsideWriteDenied` = 树外写退出码非零且文件不存在。判定按五态：探测
  不可用（子命令不存在/参数被拒/进程没跑起来）或无退出码（超时）→ inconclusive；树外
  文件落盘、或树外写退出码 0 → fail；树内写未成功 → fail；"没测到"绝不记 pass。该
  drill 只在声明 `enforcesWriteSandbox` 的车道出现（矩阵构建替换），确定性一翼是
  `npm test` 的 `test/backends/codexSandbox.test.js`（参数构建钉：首轮与 resume 轮都带
  三项 `-c`，任何路径不出现 `danger-full-access`）。
- **越界写拦截的证据组成与已知上限（决定 0084）**：活体（`containmentEvidence`——正常
  写被正确放行）+ 确定性（`npm test` 里的链式测试 `test/backends/containmentChain.test.js`
  ——各后端的协议帧走真实 parser 与控制面，验证拦截判定链）。已知上限：不再在真实车道上
  实测"模型越界并被拦住"这一整段（守约的模型拒绝往外写，无靶可拦）；后端不上报的写入
  （如 shell 命令）不在拦截面内（`docs/02-architecture.md` 已有声明）。
- **通过 → `conditional` + `certificationScope:"delta"`**：delta 子集全过**不产生** `certified`。
  `runs/reliability-summary.json` 的 worker 记录取 `status:"conditional"` + 事实字段
  `certificationScope:"delta"`（按该 worker case 的 profile/drill 覆盖派生，混合取保守值
  "delta"）。`CERTIFICATION_STATUSES` 闭集不变；scope 只活在磁盘 summary + 本文档层，**不进**
  CLI `registry list` / MCP `registry_list` 投影——wire 上该形状的 `certificationReasonCode` 为
  `null`（闭集无 delta 码，为保 MCP 面零改动不加码，不伪造近似码）。必需类目整类没有覆盖时按缺
  类目处理（`missing_certification_checks`）；类目都已覆盖、strict 以外的必需类目里仍有 inconclusive
  检查时，case 落 `conditional`，自由文本 reason 列出这些检查，`certificationReasonCode` 为 `null`。
  必需 strict 检查 inconclusive 仍落 `draft-only`。
- **全量重跑升级**：对目标 worker 重跑全量（`npm run reliability -- --agent <id>`，不带
  `--profile delta`，或 strict 行），`mergeCaseResults` 以 caseId 为键增量合并——本次全量 case
  覆盖同 caseId 的旧 delta case，status 升 `certified`、scope 升 `"full"`；未重跑的其他 worker
  结果保留。
- **监督口径**：`conditional` 的 `recommendedUse` 显示值是
  `supervised-dispatch`，"监督" = Lead 人工盯，**无机制保障**——不存在自动监督档、自动降级或
  自动限制机制。显式 CLI `--require-certified` 门对 conditional 照常放行（core 全过即放行
  的既有阈值），身份比对与 per-worker 新鲜度判定同等适用。

## 认证检查结果五态与能力轴分层

**检查结果五态**：reliability / component-check 的检查（check）结果是闭集
`pass / fail / not-applicable / blocked / inconclusive`（词汇模块
`scripts/reliability/checkStates.mjs`，两层共用；检查级字段名是 `state`——绝不叫
`status`，那是组合层保留词）。判定纪律：

- **N/A、blocked、inconclusive 都必须带原因**（`stateReason` 非空，缺原因在构造与磁盘
  两侧都被拒绝）；
- **N/A 不置绿、不算失败、不贡献能力绿**——`certifyCase` 的 `capabilities` 聚合跳过
  N/A 检查（该能力轴不被断言，summary 里不会出现 `metrics:true` 这类伪造绿）；N/A
  满足必需类目的【覆盖】语义（检查跑了、如实话不适用，lane 不因此落
  conditional）；全 N/A 的 case 触发零正向证据守卫（不得
  certified）。组件层 `componentResultFromChecks` 同纪律：judged 检查全
  {pass, N/A} 且至少一条 pass 才 pass。
- **blocked**（检查级外部阻塞——夹具/基础设施不可用）映射 case 级 `blocked`（阻塞
  不是质量失败，是证据面不可用，不满足类目覆盖）；**inconclusive** 不覆盖类目
  （fail-closed 降 conditional）。
- **现行判定规则**：backend 类声明不上报 usage（`reportsTokenUsage` 非 true——
  kimi-code 即此形状）的 lane，`metricsNonZero` 检查不适用，记 N/A + 原因；serve
  不可达时 `silentTimeout` 记 N/A + 原因；`hasSentinel` 只认 **assistant 回显**
  （tool_result/用户消息里搜到 sentinel 不算回显）；scorecard 的文件证据 = 文件
  存在 + 内容承载 sentinel；`scorecardChecksFromResult` 缺 scorecard 时记红（不用
  `completed` 顶替证据检查）。

**`reportsCommandExitCode` 诚实声明（只声明，不放行）**：backend 类第六个能力
声明成员，语义 = **WAO 今天能否产出命令退出码证据**（含 scorecard 的
toolCallId↔tool_result 0/1 推断通道，非仅 wire 原生数值）。当前声明：codex /
opencode-serve（wire 原生数值）、claude-code（逐条证明过的推断通道）为 true；zcode / kimi-web /
kimi-code / deepseek-harness / deepseek-acp 为 false。false 的依据如实：kimi-code 的
`isError` 是对输出文本的关键词匹配（输出 `Process exited with code 7` 会被读成成功）；
deepseek-harness 没有"非零退出必置 error"的实测；deepseek-acp 的 `tool_call_update`
不填协议自带的 `rawOutput`，退出码只以 `[exit code: N]` 自由文本标记出现且仅非零退出
有痕（静态核查：`scripts/reliability/dsh-acp/evidence/phase7-exit-code-wire.json`）。
声明 false ⇒ strict/scorecard 的 `commandsPassed` 类检查在证据不可取得时记 **N/A +
原因**（不置绿、也不算失败）；若 scorecard 已明确观察到非零退出则保留真实 fail。
产品侧的 scorecard 也按这条声明门控推断：声明非 true 的 backend 上，命令事件不带
数值退出码时 `requireCommands` 通不过；组件层的角色合同探针因此只对声明 true 的
backend 带这条规则。必需 strict 轴为 N/A 的 case 保持
`draft-only`，不能仅靠能力声明进入可派发集合——**例外只有一条**（为什么见决定
0073：Owner 给出目标并授权，判据由 Lead 在授权下确定、经联合会审）：命令退出码
证据这一轴（`capability=commandEvidence`）因 backend 如实声明不产出而不适用的 case
评 `conditional`（监督派发，封顶 conditional）。其它 strict 轴的
N/A、strict 证据不足（inconclusive）与 strict 失败仍是 `draft-only`——**要求的命令
根本没执行属于 strict 失败**，不归入"退出码证据不可得"
（`scorecardCommandFailureIsCredible` 保留它与观察到的非零退出）；再有放宽须 Owner
另行显式裁定。

**被测 harness 的运行时身份入账**：组件层认证入口（`npm run component-check`）对每个
backend 被测恰一次实际执行前缀的版本探测（`agent.binary` 优先，保留
`agent.prependArgs`，再附 `--version`；`scripts/reliability/runtimeIdentity.mjs`），
把 `runtimeIdentity`（`distribution` / `version` / `binaryPath` / `fingerprint` /
`verified` / `reason`）记进组件记录；组件键为 `backend:<name>@<codeRef>#<runtimeFingerprint>`。
**只做 advisory/stale 可见性**：版本漂移 → 同 (name, codeRef) 的历史记录降
`runtime-drifted` advisory「建议重跑」（不删）；不进认证门、不加 registry schema
字段。探测失败或无本地二进制时明确 `verified:false`，指纹按探测目标稳定派生为
`unverified-v1-*`：这只避免同一未验证目标每次制造新键，绝不表示运行时身份已验证。
opencode-serve 是 HTTP 服务 backend，因此保持稳定的未验证身份。

**能力轴分层骨架**（组件层 / 组合层各测什么——全表按需扩充，本节只定层）：

- **组件层轴**（`npm run component-check`，backend/llm 单独验证，零承重）：
  1. **声明闭集双向一致性**——`readBackendCapabilities` 的七轴闭集
     （`supportsRoleContract` / `supportsSessionReuse` / `supportsInFlightCorrection` /
     `replayByRespawn` / `reportsTokenUsage` / `reportsCommandExitCode` /
     `enforcesWriteSandbox`）逐轴对账：
     declared=true ⇒ 正向实测证据（sessionReuse 须真实跨 run 恢复证据——已登记证据
     的 backend 见 `SESSION_REUSE_EVIDENCE_SOURCES`：deepseek-acp / codex / kimi-code，
     未登记证据的 backend 如实红；roleContract 须合同内 marker 的模型回显；exitCode
     须探针 run 的 scorecard commandsPassed；tokenUsage 须 input 双向一致）；
     declared=false ⇒ 配置面必须明确拒绝（systemPrompt / sessionReuse 的 spawn
     前硬门探针）或按既定纪律记 N/A（exitCode / 无配置面的轴 + 原因）。
  2. **生命周期 / 投影完整性**——启动与配置传递（不支持参数明确拒绝）、正常完成 /
     启动失败 / 中途错误 / 等待到期 / 显式停止（按执行形态分车道）、事件与证据转换
     （缺字段/乱序/重复/断流不制造成功证据）。零真实模型即可判定其中大部分探针
     （拒绝类探针在派发前失败）。
- **组合层轴**（`npm run reliability`，按席位 agentId 认证，承重）：交互闭环——
  `complete`（完成诚实）/ `assistantText`（非伪完成）/ 证据族（`commandEvidence` /
  `fileEvidence` / `toolEvidence` / `fileMaterialized` / `readFiles` / `metrics`）/
  `containmentEvidence`（越界写拦截活体取证，决定 0084）/ `sandboxEnforcement`
  （OS 写沙箱执行取证，不经模型，决定 0086——声明 `enforcesWriteSandbox` 的车道
  取代 containmentEvidence 的位置）等 case 级能力，产出
  certified/conditional 台账（`runs/reliability-summary.json`）。
- **配置表达力四子轴**（model / reasoning / contextWindow / provider）**不在本节
  复制**——权威源是生成层 `docs/surface/certification.md`
  （`npm run gen:certification` 从 backend 代码派生，字节钉由
  `test/isolation-infra/docsSurface.test.js` / `docs-consistency.test.js` 守卫）；
  此处复制会制造第二份会漂移的真相源。

**认证证据绑定执行画像 + 只读适用性三态**：
组合层认证（`npm run reliability`）新写入的 case 记录实际生效的执行画像——`modelId` /
`providerID` / `providerKey` / `effort`（取自该 lane 的 registry 配置，与派发同源）、
`runtime`（复用 `runtimeIdentity.mjs` 探测，探不到如实 `verified:false`）、`codeRef`
（git HEAD 只读获取）、`capturedAt`、各 drill 的 `runId`（`drillRunIds`；drills.mjs
不上抛内部 runId 的 drill 如实记 `null`；派发失败占位 `unknown` 同样归 `null`）。

**drillRunIds 取证闭环**：sentinel/scorecard 的 run 转录持久化在
`runs/reliability/<runId>.jsonl`（runs 归档清扫只处理顶层 `*.jsonl`，子目录语料不在
清扫面内），每个 id 可独立回查；写 summary 前逐 id 守卫（fresh id 缺转录 = 拒绝
写盘并非零退出——绝不记录指向已删除/不存在证据的 id），旧版取证遗留的悬空 prior id
写盘前如实置 `null` 并告警。

**发布路径零删除**：生成/发布 summary 的路径只写不删。写盘后按【进程内】summary 的
引用集清理，会与其他发布者不协调（A 写→B 写+清理→A 恢复清理 ⇒ 最终 summary 引用
的转录被删；B 写完中断、A 再收尾亦复现）。删除唯一入口 = 显式维护步骤
`node scripts/wao-node.cjs scripts/reliability/prune-drill-transcripts.mjs [--max-age-days <n>] [--dry-run]`
——删除前**重新读取磁盘上的当前 summary**，只删「未被任何条目引用 且 超过年龄阈值
（默认 7 天）」的转录；被引用的绝不删（无论多老）；summary 缺失/不可解析时一个都
不删（fail-closed）。

**增长有界是带条件的**：仅当该维护步骤被例行执行（建议与
runs 清扫 runbook 同频，且维护时无进行中的 reliability 运行——年龄阈值只是维护
步骤自身 TOCTOU 窗口的兜底，不是并发协调机制）时，`runs/reliability/` 才收敛到
「当前 summary 引用集 + 阈值年龄窗口内」的转录量；无人执行维护时目录只增不减
（重认证不断产生被取代的转录），维护中被锁跳过的文件依赖下一次维护，不自动收敛。
旧记录不补猜值（缺画像即 unknown）。

**查询侧**：`registry list --cert-evidence`（text 追加详情块 / `--format json` 附
`certificationEvidence` 数组，与 `registry_list` 共用
`src/application/registryInventory.js` 服务）按席位分列展示**声明 / 组件观测 / 组合
结果 / 证据适用性 / 限制与来源**。**取证时间在两处渲染里保留**：组件观测行携带
`lastVerifiedAt`；组合列携带画像 `capturedAt` 与全绿 `lastFullHealthyRunAt`，
后者**缺席时两路统一渲染 `lastFullHealthy=?`**——缺席显示 `?`、不整项省略；
`--format json` 的服务行保留全部原始时间戳字段——渲染层不得丢弃取证时间。
台账来源状态（缺文件 / 不可解析 / 读取错误）分别可辨，不复用有损吞错的简表
路径；`drillRunIds` 记录了 id 但对应转录不在回查位置时浮出
`drill-evidence-unresolvable` 限制项（不改三态）。

**自然时效限制项**：组件观测除复制磁盘 `advisory.code` 外，还按
`componentLedger.mjs::classifyComponent` 的时间维**现算**自然过期——组件记录自身
`lastVerifiedAt` 超 30 天新鲜期（或缺时间戳不可证新鲜，fail-closed 同判）→
`component-expired:<n>`；夹具资格自然过期（`qualifiedAt` 超 30 天或
`ownerValidUntil` 已过、且未预标注）→ `component-fixture-decayed:<n>`。两类未预
标注的自然过期在 CLI 与 MCP 两路都显示为**限制项**（措辞不淡化成"无"；只是
advisory 提醒，不改三态、不进门禁），且组件限制汇总（来源状态/blocked/advisory/
自然时效）在**所有适用性路径**（matched / mismatched / undeterminable）都执行——
非 matched 的早返回不得吞掉组件侧并列事实。阈值常量在 src 侧以同值常量镜像
（layering 冻结 `src/**` 不得 import `scripts/**`），由
`test/registry-roles/certificationEvidenceInventory.test.js` 的**等值钉**守恒
（测试同时 import 两侧，常量或边界漂移即红）；owner 期限**等号边界**已纳入等值钉
（`now === ownerValidUntil` 仍有效——严格大于才过期，双侧同判）。

**证据适用性三态**：闭集 `matched / mismatched / undeterminable`，判定 fail-closed
（不复用 `matchedCertRecord` 的缺字段容忍——那是派发门"旧记录不误杀"的取舍，
取证路径缺身份就是无法证明）：记录的 executionProfile 身份四元组（`modelId`/`providerID`/
`providerKey`/`effort`）不完整（`modelId`/`effort` 须非空字符串；`providerID`/
`providerKey` 须非空字符串或 `null`=已观察无接入方）、画像不明（legacy 记录无执行
画像）或台账来源不可用/无记录 → `undeterminable`；四元组与当前声明不一致（含
provider 一侧 `null` 一侧非 `null`）、与记录顶层身份矛盾（如
`executionProfile.modelId` ≠ 顶层 `modelId`）、或 effort 不同 → `mismatched`；全等 →
`matched`。**`undeterminable` 绝不算绿**，且该列**绝不**与
组件/组合结果合并派生"总体可用=true"——只读展示，不改派发门（`--require-certified`
与 `matchedCertRecord` 语义不变；effort 纳入派发身份是 Owner 级决定）。

**MCP 侧同款按需投影**：`registry_list` 传 `detail:"certificationEvidence"` 时返回
可选 `certificationEvidence` 行（同一服务、五列与来源状态保真；默认调用一字不变；
advisory-only，`requireCertified=false` 与 CLI 门禁语义原样）。

**认证更新的触发器与执行人**（不改代码行为，只定规程）：

- **更新频次 = 事件触发为主**：① 上游运行时版本变更（操作员升级 claude/codex/kimi/
  dsh 等后——组件层入口的 runtimeIdentity 探测会把版本漂移显式标成 advisory）；②
  WAO 适配代码变更（backend/parser 改动 = codeRef 滚动，旧组件键自然过期）；③
  **席位有效配置变化（model / reasoning / provider）**：Lead 判断影响面 → 安排该席位
  **定向重验**（重跑其认证 case），或**明确记录暂缓及使用限制**（何时补验、在此之前
  该席位按什么范围降级使用）。配置变更后的旧证据不自动适用（新证据记录执行画像，
  只读适用性三态见上段）。
- **时间窗兜底**：沿用 `componentLedger.mjs` 的 `DEFAULT_MAX_AGE_DAYS=30` 作为**审阅
  提醒**（超期记录消费为 stale advisory）——**不**做每月无差别全量重跑；30 天窗是
  **组件记录的审阅提醒，不能替代配置变更后的影响判断**（记录未超期 ≠ 对新配置适用）。
- **派发报错是最后防线**：派发失败只记回归信号（组件层红 = 新鲜度分叉），**不**
  自动耗 token 重考。
- **执行人**：**操作员**负责安装/升级 runtime；**Lead** 界定影响面并调度重验（哪个
  backend/组件受版本漂移影响、要不要跑 component-check / reliability）；**Owner**
  决定新增组合、费用与承重用途。
- **组件层不进派发门禁**——组件结论是 advisory 证据，绝不是 permission gate。

## 场景 1b：单次派发换模型（--model）

"这一次派发换一个模型跑" 这类**单次生效、不落配置**的模型覆盖：

```powershell
# 前台：立即回显 effective model，然后照常等待并打印摘要
npm run cli -- run sol --prompt "..." --model <modelId>

# 后台：JSON 里带 model 字段（派发时刻即见，不必等 provider）
npm run cli -- run sol --prompt "..." --background --model <modelId>
```

语义要点：

- **只替换 `model.id`**：注册表里 model 是嵌套对象（canonical `{id, contextWindow?}`；opencode-serve 是 `{providerID, id, variant}`）。覆盖只改 `.id`，兄弟字段（contextWindow / providerID / variant）全部保留；注册表没有 model 的 worker 会合成出 `{id}`。合成发生在 `validateAgentPolicy` 与 `run.started` 落盘之前——策略校验照常跑合成后的对象，`run.started` 的 `model` 字段即合成后策略，并**另加显式 `modelOverride` 字段**（审计可区分"改注册表"与"一次性覆盖"）。
- **回显 effective model**：前台 text 格式在派发成功时打印一行 `effective model: {...}`；`--format json` 把同一对象作为结果里的 `model` 字段；后台 JSON 输出带 `model` 字段。**失败模式**：WAO 不校验模型 id 是否真实存在——打错的模型名要到 provider 期（worker 启动后）才报错，回显就是让你在派发时刻立刻看见打错了什么（回显是 advisory：展示的是 WAO 实际下发了什么，不证明 provider 接受该 id）。
- **resume 继承覆盖事实**：`resume`（含 daemon `--resume-on-start` 接管）从 `run.started.modelOverride` 同源重建覆盖——后台派发带 `--model` 后 runner 崩溃、daemon 接管续跑时，后半程仍跑派发时的模型，transcript 里的覆盖事实不失真。合成与形状门与 start 同一道（只替换 `.id`；持久化值非法则拒绝 resume，fail-closed）；resume 不接受调用方新传的覆盖。
- **两道硬互斥（fail-fast，零副作用）**：
  1. `--model` × `--require-certified`（闭集码 `model_override_certified_conflict`）：无条件互斥——认证矩阵按 provider+model 组合记录，任何覆盖（即使值与注册表一致）都使"已认证组合"声明失效。CLI 在 argv 边界早拒；`RunManager.start` 顶部作权威拒绝（前台/后台/workflow/daemon 全通道同一语义）。
  2. `--model` × provider-session 复用派发（闭集码 `model_override_reuse_conflict`，typed `ModelOverrideConflictError`）：reusable expert（`sessionReuse: "lead_workspace"`）与 continuable delivery 谱系根两形状都拒——跨回合续用的 provider 会话必须跑同一个模型（resume 侧只从 `run.started` 重建该 run 自己的覆盖事实、不接受调用方新传覆盖；派发时再换模型会破坏 provider 会话契约）。dispatchRun 在路由槽/transcript/fork 之前拒绝。
- **正交放行**：`--model` × `--read-only` 可同用（金丝雀换模型试跑是合理用法）；`--model` × `--delivery-spec-file`（及 MCP `delivery` 块）放行，但**该 run 的认证组合声明失效**——reliability 认证按注册表的 provider+model 组合记录，覆盖后的组合未经认证；override 事实已由 `run.started.modelOverride` 入 transcript 供审计。
- **形状门**：非空 string、长度 ≤128、不以 `--` 开头、不含空白/控制字符。`--` 前缀规则是承重的——后台 runner 的 `parseSimpleFlags` 会把 `--` 开头的值当下一个 flag，值对会静默断裂。违规以固定文案 fail-fast（不回显原值）。MCP `run_dispatch` 的 `model` 参数走同一 SSOT（wire schema 正则与核心校验器同源）。
- **排除边界**：`--model` 只存在于 `run`（含 `--background`）与 `retry`（retry 上为替换继承值，见「retry 的 per-dispatch 覆盖继承」节）。`spawn` 显式拒绝（多席统一模型语义混浊，Owner 场景是单派发）；workflow agent 节点与 daemon 派发不解析该 flag——声明式表面的模型应写进声明本身（注册表 model 策略）。持久换模型 = 改注册表，不是加 flag。

（MCP 面）**单次模型覆盖（可选，`model`）**：`run_dispatch` 顶层可带 `model`（`"model": "<modelId>"`，CLI 等价 `run --model`，完整语义同本节 CLI 面）——单次生效、不落注册表、只替换注册表 model 的 `.id`（contextWindow/providerID/variant 保留），wire schema 与核心校验器同源（非空、≤128、不以 `--` 开头、无空白/控制字符）。互斥与放行：× provider-session 复用（reusable expert / continuable 谱系根）以固定文案拒绝（闭集码 `model_override_reuse_conflict`——"A per-dispatch model override cannot be combined with provider-session reuse … must run one model"）；认证互斥（closed-set `model_override_certified_conflict`）在 MCP 侧不可达——`requireCertified` 恒为 server-owned `false`，认证矩阵（provider+model 组合的 certified 记录）只在 CLI 显式 `--require-certified` 时被求值；× `delivery` 块放行，但**该 run 的认证组合声明失效**（认证按注册表 provider+model 组合记录，覆盖后的组合未经认证）——override 事实由 `run.started.modelOverride` 入 transcript 供审计。派发成功不回显 effective model（MCP 输出 schema 冻结为闭集字段）；打错的模型名要到 provider 期才报错，需即时确认时读 transcript 的 `run.started.model`。

## 场景 1c：单次派发换推理力度（--reasoning）

"这一次派发用 xhigh 推理力度" 这类**单次生效、不落配置**的推理力度覆盖（与 `--model` 可同用）：

```powershell
# 前台：立即回显 effective reasoning（与 --model 同用时合并为一行 effective 回显）
npm run cli -- run sol --prompt "..." --reasoning xhigh

# 与 --model 同用
npm run cli -- run sol --prompt "..." --model <modelId> --reasoning xhigh

# 后台：JSON 里带 reasoning 字段（派发时刻即见，不必等 provider）
npm run cli -- run sol --prompt "..." --background --reasoning xhigh
```

语义要点：

- **只替换 `reasoning.effort`**：注册表里 reasoning 是嵌套对象（canonical `{effort}`）。覆盖只改 `.effort`，合成发生在 `validateAgentPolicy` 与 `run.started` 落盘之前——策略校验照常跑合成后的对象；`run.started` 的 `reasoning` 字段即合成后策略（无论有无覆盖都落盘，静态 reasoning 同样可审计），并**另加显式 `reasoningOverride` 字段**（审计可区分"改注册表"与"一次性覆盖"）。
- **闭集值域**：`minimal / low / medium / high / xhigh / max`（`registry.js` 的 `REASONING_EFFORTS` SSOT，六值导出）。集外值（含大小写变体如 `HIGH`）以固定文案 fail-fast（不回显原值）。MCP `run_dispatch` 的 `reasoning` 参数走同一 SSOT——wire schema 直接序列化闭集枚举（zod enum，比正则更严）。
- **无能力布尔（设计决策）**：不可表达（opencode-serve 拒绝任何 `reasoning.effort`）与条件不支持（kimi 仅 K3 模型 × {low,high,max}；deepseek-harness 仅 high|max）都走**既有 per-backend policy 门自然拒绝**——合成后的对象照常过 `validateAgentPolicy`，拒绝时追加指对 `--reasoning` 旗标的固定提示句（不回显值）。平面"能力布尔"编码不了这些条件支持，故不设。
- **与 `--model` 可同用**：两个覆盖各改各的字段（`.id` / `.effort`），互不干扰；前台回显合并为一行 `effective model: {...}, reasoning: {...}`（advisory：展示 WAO 实际下发了什么，不证明 provider 接受）。
- **resume 继承覆盖事实**：`resume`（含 daemon `--resume-on-start` 接管）从 `run.started.reasoningOverride` 同源重建覆盖——后台派发带 `--reasoning` 后 runner 崩溃、daemon 接管续跑时，后半程仍跑派发时的力度。合成与闭集门与 start 同一道；持久化值非法则拒绝 resume（fail-closed，零 re-spawn）；resume 不接受调用方新传的覆盖。
- **两道硬互斥（fail-fast，零副作用，"任一覆盖在场即拒"）**：
  1. `--reasoning` × `--require-certified`（闭集码 `reasoning_override_certified_conflict`）：无条件互斥——覆盖改变认证组合被测量时的执行包络，任何覆盖都使"已认证组合"声明失效。CLI 在 argv 边界早拒；`RunManager.start` 顶部作权威拒绝。
  2. `--reasoning` × provider-session 复用派发（闭集码 `reasoning_override_reuse_conflict`，typed `ReasoningOverrideConflictError`）：reusable expert 与 continuable delivery 谱系根两形状都拒——跨回合续用的 provider 会话必须跑同一推理力度。dispatchRun 在路由槽/transcript/fork 之前拒绝。**组合策略拒绝指对旗标**：`--model` 与 `--reasoning` 同用时撞复用，model 冲突先拒（确定性顺序，runDispatch.js 注明）；policy 门拒绝的提示句按在场覆盖组三种形状（仅 model / 仅 reasoning / 双覆盖）指对旗标。
- **正交放行**：`--reasoning` × `--read-only` / × `--delivery-spec-file`（及 MCP `delivery` 块）可同用（同 `--model` 的认证组合声明失效注意事项）。
- **排除边界**：`--reasoning` 只存在于 `run`（含 `--background`）与 `retry`（retry 上为替换继承值，见「retry 的 per-dispatch 覆盖继承」节）。`spawn` 显式拒绝；workflow agent 节点与 daemon 派发不解析该 flag——声明式表面的推理力度应写进声明本身（注册表 reasoning 策略）。持久换力度 = 改注册表，不是加 flag。

（MCP 面）**单次推理力度覆盖（可选，`reasoning`）**：`run_dispatch` 顶层可带 `reasoning`（`"reasoning": "minimal"|"low"|"medium"|"high"|"xhigh"|"max"`，CLI 等价 `run --reasoning`，完整语义同本节 CLI 面）——单次生效、不落注册表、只替换注册表 reasoning 的 `.effort`，与 `model` 参数可同用。wire schema 直接序列化闭集枚举（`registry.js` 的 `REASONING_EFFORTS` SSOT 经 runDispatch 下向 re-export——zod enum，比正则更严，与核心校验器零漂移）。互斥与放行：× provider-session 复用以固定文案拒绝（闭集码 `reasoning_override_reuse_conflict`——"A per-dispatch reasoning effort override cannot be combined with provider-session reuse … must run one reasoning effort"）；认证互斥在 MCP 侧不可达（同 `model` 的 server-owned `false` 构造）；× `delivery` 块放行。不可表达（opencode-serve）与条件不支持（kimi K3-only、dsh high|max）组合走既有 per-backend policy 门自然拒绝。**`run_dispatch_contract_check` 共享该输入 schema 但有意忽略 `reasoning`**（它只就 delivery 合同给 advisory——与对 `model` 的忽略同一先例）。派发成功不回显 effective reasoning（MCP 输出 schema 冻结）；需即时确认时读 transcript 的 `run.started.reasoning`。

## retry 的 per-dispatch 覆盖继承（与 resume 重建链对称）

- **任务文本取法**：retry 派发的任务文本取**本 run 最后一条 `prompt.sent` 记录（纯 runId 绑定）**——尾部追加的跨 runId 伪造记录不采信（信封绑定纪律，读取器 SSOT 在 `transcript.js` 的 `findLatestBound`/`findFirstBound`）；合法双写形状（spawn 前首写 + spawn 后补写）仍取最后一条——ProcessBackend 家族的合法双写落盘均无 `messageId`（spawn 结果的 `undefined` 经 JSON 序列化丢键），取法不按 `messageId` 挑选。诚实边界：绑定只杀跨 run 注入与错读——同 runId 的伪造追加（无论是否带 `messageId`）仍会被采信；该攻击面等同于持有 `runs/` 写权限，读取端无解，真边界在写入端完整性。
- **legacy transcript 硬拒绝**：信封时代之前的 legacy transcript（事件无 `runId` 字段）经绑定读取器找不到本 run 的 `prompt.sent` → retry 硬拒绝（固定文案："no runId-bound prompt.sent found in this transcript — pre-envelope legacy formats are not retryable through the bound reader; re-dispatch explicitly with `run`"）；`resume` 对无信封 legacy transcript 同样拒绝（return null，与 resume 既有拒绝语义一致）。resume 的终态门也是同款 runId 绑定——尾部追加的外 run/伪造 `run.state_change` 不再把 terminal run 的拒绝翻成接续、也不再误拒合法续接；legacy 拒绝语义（null）不变。
- **继承范围**：retry 重新派发**任务文本与 per-dispatch 覆盖**；delivery 声明 / 只读声明 / 隔离形状**不**继承——需要完整形状时用 `run` 显式重发。
- **覆盖事实原样继承**：源 run 的 `run.started.modelOverride` / `run.started.reasoningOverride` 事实被**原样继承**到新派发——权威是**首条绑定该 runId 的 `run.started`**（transcript 信封绑定纪律，与 resume 的首条取法同族；尾部追加的伪造 `run.started` 即使形状合法也不采信）。值仍过 `run` 既有的形状门/闭集门与合成入口——新 run 的 `run.started` 落同样的覆盖事实。源 run 无覆盖且未显式给 flag → 零覆盖（与旧输出逐字节一致）。
- **旧格式宽容**：源 transcript 缺 `run.started`（信封前旧格式）→ retry 按**零覆盖**放行，不拒绝——与 resume 的拒绝语义不同但各自正确（resume 要接续同一会话，找不到事实只能拒绝；retry 是全新派发，零覆盖即注册表策略）。
- **替换 flag**：`--model <id>` / `--reasoning <effort>` **显式替换**对应继承值（校验与 `run` 同源：模型 id 形状门 + effort 六值闭集 `minimal/low/medium/high/xhigh/max`）；不给 flag 则用继承值。
- **坏持久化值 fail-closed 拒绝**：源 transcript 的覆盖值损坏（非字符串/空/`--` 前缀/含空白/超长、或 effort 集外）时 retry 直接拒绝（固定文案指向源 run，`retry_inherit_model_invalid` / `retry_inherit_reasoning_invalid`，零新 transcript）——绝不静默忽略、绝不静默降级回注册表模型。显式替换 flag **不豁免**坏值拒绝（坏 transcript 事实一律拒绝；flag 形状门先于该检查，两者文案不同）。
- **可见性**：成功输出在确有继承/替换时携带 advisory 字段 `inheritedOverrides`（`model`/`reasoning` 各带 `value` + `source: "inherited"|"replaced"`；与 effective model 回显同一措辞纪律——展示 WAO 下发了什么，不证明 provider 接受该值）。无覆盖时该字段缺席。
- 想做**无覆盖**重试（回到注册表策略）：不要用 retry——直接 `run` 用原 prompt 重发即可。
- **reuse 形状**：retry 走前台入口，**不解析 sessionReuse 路由**（只有后台派发通道解析）；reuse 形状 agent 的 retry 会以**全新 provider session** 派发（与前台 `run` 同族）——不撞 reuse 互斥门，也不复用旧会话。retry 无 `--require-certified` 入口。

## 认证与当前就绪（历史认证 ≠ 当前可用）

核心边界一句话：**认证是历史可靠性记录，不等于"此刻可启动"**——当前凭据、授权与容量只能由实际 run 的终态事实形成。

**认证 advisory 上下文**：每个 agent 额外携带两个 advisory 字段——`certificationReasonCode`（闭集机器码，解释"为什么不是 certified"：`case_blocked`（外部 blocker：provider/credential/quota，或显式 blocked）/ `core_checks_failed` / `strict_evidence_failed` / `operational_or_observability_failed` / `missing_certification_checks`，分支优先级与 reliability 认定一致，blocked 优先于 core 失败）与 `certificationLastHealthyAt`（该 worker 最近一次全绿 case 的 bounded ISO-8601 UTC 时间戳，认证新鲜度）。`certificationReasonCode` 在 `certified` 时为 `null`（闭集权威 `certificationReasons.js` 只对 certified 规定原因码为 null，时间字段不受此约束）；`certificationLastHealthyAt` 与 status 投影**相互独立**——无 summary 记录、identity（backend/modelId；记录与 agent 双侧声明 `providerID` 时同比对；`providerKey` 同为第 4 比对维——记录侧缺字段 = legacy 容忍，显式 null = 已观察无接入方，判定与派发门共用 `runManager.js` 的 `matchedCertRecord` SSOT）变更后认证不可继承、以及旧格式 summary（缺字段）时为 `null`；`certified` 且存在合法全绿历史时**保留该历史时间**（合法历史时间不因 status 为 certified 而清空）——两字段一律**不伪造**。闭集唯一权威在 `src/application/certificationReasons.js`（MCP schema enum 从它派生，无第二份清单）；worker 级 `reasonCode` 取"决定最终（最差）status 的 case"的码，`lastHealthyRunAt` 聚合 active identity 各 case 的最近全绿时间（旧 identity 的全绿不计入）。两字段只含闭集码/日期——blockerReason 原文、路径、命令、stderr 绝不进任何 wire 输出（磁盘 summary 里的自由文本 `reason` 是另一层契约，保持不变）。

**凭据可用性**：`certification` 是历史可靠性认证结果，不等于"此刻可启动"。`credentialAvailability`（`available` / `missing` / `not_required`）只反映 worker **registry 显式声明为必需**的 credential（`provider.apiKeyEnv` / legacy `--api-key-env`）是否在当前环境可用——不声称 runtime 整体健康。优先 `process.env`，回退 Windows Current-User 环境，两处都缺失则为 `missing`；未声明必需凭据的 worker 为 `not_required`。**可选继承变量**（如 `OPENAI_BASE_URL`、`CODEX_HOME`、`KIMI_MODEL_NAME`）会被继承但不参与 missing gate——不会因缺少可选配置阻止派发。`missingCredentialEnvNames` 列出缺失的必需 env 变量**名**（绝不包含值）。`run_dispatch` 在 transcript 写入和 fork 前用同一 readiness 检查拒绝 `missing` 的 worker（零 transcript、零 fork），返回固定可行动错误。WAO 不保存/轮换凭据，不批量导入用户环境，只读取 registry 明确声明的精确变量名；设置或轮换凭据后**无需重启 Host**（每次评估重新观察当前状态）。

**provider readiness 真相（truth）**：`providerReadiness` 是严格投影对象，字段含义：

- `configurationStatus`（恒为 `"configured"`）——只证明该 registry 条目已配置，**不等于** worker 可运行；
- `authenticationStatus` / `entitlementStatus`（恒为 `"unknown"`）——本次 inventory **没有做任何 provider 探测**，因此**永远不得**宣称已认证/已授权；
- `liveCheckStatus`（恒为 `"not_checked"`）——本次调用**没有做 live check**；
- `credentialAvailability`——同"凭据可用性"语义，只证明必需凭据 env 名存在（或无需凭据）。

这也意味着 `complete:true`、`certified`、`credentialAvailability:"available"/"not_required"` 与 WAO 控制面工具可用，都**不能**证明当前 provider 仍有 quota 或未触发 rate limit。它们是配置/历史/本地观察事实；实时容量只在实际 run 的终态错误中形成事实。

**语义铁律**：preflight/registry 查询"完成"只表示机械事实（registry 可读、必需凭据 env 名存在/不存在、配置条目存在）可读，**不是** authenticated/entitled/live-checked 的证明。本包不做 provider 网络请求、不读凭据值，所以结构上不可能投影出 `authenticated` / `entitled` / `checked`——MCP schema 的枚举直接派生自这些闭集常量（`src/application/registryInventory.js` 的 `CONFIGURATION_STATUSES` / `AUTHENTICATION_STATUSES` / `ENTITLEMENT_STATUSES` / `LIVE_CHECK_STATUSES`），不存在第二份手工维护列表。真实认证/授权状态只能来自实际运行/诊断（见 `run_diagnose` 的 `code`）。

registry certification 是 **advisory 证据，不是 permission gate**：`registry_list` / `lead_preflight` 把每个 worker 的 `certification` 状态报告给 Lead，MCP dispatch/continuation 以 `requireCertified: false` 调 shared service，**不**强制认证——没有 reliability-summary.json 的 Fresh 克隆同样可派发（lead_preflight 已报告 configured/credential 事实，认证仅作参考）。显式 CLI `--require-certified` 与 RunManager 的 opt-in 认证门保持完整——CLI 或项目治理仍可要求认证。

**显式 CLI 认证门（`--require-certified`）的现行判定**（读 runDir 下 `reliability-summary.json`）：

- **记录选择**：席位键精确命中优先（`manualOverride` 坐记录上）；未命中且台账为车道键空间（lane-v1）时按身份事实匹配扫描（同一 `matchedCertRecord` 判定）。
- **身份比对（四元组）**：记录的 backend/modelId（`providerID` 在记录与 agent 双侧声明时同比对；`providerKey` = `<规范化 baseUrl>|<apiKeyEnv 变量名>`，单一实现 `src/providerFingerprint.js`——baseUrl 归一化（scheme/host 小写、去默认端口、路径保留大小写仅去尾斜杠、丢弃 userinfo/query/fragment 防凭据落盘），apiKeyEnv 只取**变量名**、绝不取密钥值）必须与当前 registry 该 agent 的配置一致，不一致按未认证拒绝（固定文案，不回显配置值；判定与 `registry_list` 投影共用 `matchedCertRecord` SSOT）——改 `config/agents.json` 换 backend/model/接入方后不重跑 reliability，旧组合的认证不放行。`providerKey` 记录侧缺字段（undefined）= legacy 跳过该维；显式 `null` = 已观察无接入方，与 agent 侧不可派生（null）匹配、与可派生不匹配；双侧非 null 时逐字节比对。reliability 写入侧与派发门比对侧同源调用（契约测试钉死逐字节一致）。
- **status 阈值**：`certified` / `conditional` 放行（core 全过即放行的阈值）；其余按未认证拒绝。
- **新鲜度（全量口径）**：读该 worker 的 `lastFullHealthyRunAt`（仅 full-scope 且全绿的 case 刷新；delta 全绿是 conditional，不洗白全量口径的派发新鲜度；记录侧无条件写，`null` = 从未有全量绿）。仅 legacy 记录缺该字段（undefined）才回落旧判据 `lastHealthyRunAt`（文案如实标注实际读取的字段名）；显式 `null` 与坏时间不回落、直接 fail-closed 拒绝（固定文案锚点"无新鲜认证/认证已过期"；过期 reason 只展示天数，不回显磁盘时间戳原文）。超过新鲜窗口（默认 30 天）即拒。
- **Owner 旁路**：`manualOverride:"cleared"` 在 summary 中**找到该 worker 记录后**才生效（无记录仍拒），并绕过身份、状态、新鲜度三项检查。
- **配套可见性（非阻塞）**：`registry validate` 对已注册但 summary 记录缺 `providerKey` / `lastFullHealthyRunAt` 的 lane 输出 legacy 台账 advisory（随 validate 既有 ⚠ warning 通道逐行打印/进 `--format json` 的 `warnings[]`，不改 validate 的通过/失败语义）；存量记录**不自动重认证**——补全新维度/新字段的唯一路径是对目标 worker 重跑 `npm run reliability -- --agent <id>`。

**lead_preflight 证明边界**：preflight 完成永不意味着任何 worker 已被认证/授权/做过 live check（每个 worker 的 `providerReadiness` 恒为 unknown/not_checked）。

**conditional worker 边界**：Active run、conditional worker、dirty workspace 只是事实，不自动禁止派发。
