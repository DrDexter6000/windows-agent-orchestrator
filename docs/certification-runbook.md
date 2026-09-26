# 认证 Runbook（认证操作正文唯一权威）

> 状态：运维（Runbook）类。2026-09-26 自 `docs/usage.md` **文件级全文迁移**建立（Owner 授权；独立审计 run_202609260428356418le3e6 PASS-with-change 修正后执行）：原文完整移动，本文件是认证操作正文的**唯一权威**；`docs/usage.md` 原位置只保留原具名标题与指向本文件的单向链接，不保留第二份当前正文。这不是 TD-187 已回退的索引/节选路线——迁移单位是完整正文，不是锚点清单。
> 阅读入口：`docs/ssot.md` §0.1 `seat-certify` 行（无条件全文必读五文件之一）；多行动面命中取并集、正文显式依赖继续跟进、读取输出被截断必须补齐。判读 `adversarialEscape`（越界写对抗）时连读 `docs/02-architecture.md` §4.6 Coder Delivery Contract 与 §4.1 状态机（追加依赖，非独立入口）。
> 本文件自足承载认证操作正文，**不把必需认证义务路由回 `docs/usage.md`**；命令/参数参考仍在生成层 `docs/surface/`（权威源是代码，随代码再生成）。

## 认证结果用于派发选择的边界（原 usage「当前派发策略」）

当前派发策略：
- 真实编码/文件修改/命令执行优先用 certified Claude Code worker（如 `coder_hq` / `coder_low`）。
- 标准角色以 `docs/team-roles.md` 为权威，配置落地以 `config/agents.example.json` 为模板。
- opencode worker 只作为 fallback / optional lane，用于需要 token 闸门精确控成本、且经过认证的特定模型任务。
- runtime/model 是否可进入 strict dispatch，以 `npm run reliability` 生成的 `runs/reliability-summary.json.workers` 为准。
- opencode stop 路径已有 TD-37/TD-38 后台 quietness 验证；派发前仍必须看最新 certification、`tokenBudget` 和 stop verification evidence。

## DSH 通道适用限制与能力交叉警告（原 usage registry 配置详解段）

`deepseek-harness` 配置只负责 detect/invoke/report：WAO 要求 `binary` 指向一个可启动的
DSH SDK JSON-RPC runtime，`dshConfigPath` 可读，`credentialEnv` 只写环境变量名；凭据值仍由
现有 Windows user-env bridge 注入子进程。DSH composition 应关闭内部 subagent、workflow、
approval UI、background job 和 TUI，把模型、PowerShell/编辑工具与 JSONL session storage 显式
装配进去。WAO 不生成、升级或持久修复该外部 runtime。该 backend 目前无 session reuse / in-flight
correction，且本仓模板不把它设为默认 worker；通过 `npm run reliability` 取得与当前
backend+model 精确绑定的认证前，registry 会诚实显示 `certification:null`。

`deepseek-acp`（ADR-0031，与上条旧线并存）走上游 shipped 的 `dsh --profile acp`：
WAO 以 `--patch <containment> --patch <role-contract>` 叠加两份覆盖层——containment
资产**由操作员安装**到 `~/.wao/runtimes/dsh-acp/wao-contain.patch.yml`（内容与版本依据 =
仓库内 `scripts/reliability/dsh-acp/wao-contain-safe.patch.yml`，直接复制即可），缺失或与声明
不匹配时 backend 在派发前**拒绝**（fail-closed，不静默降级）；角色合同由 WAO 每次派发生成到
OS temp 独占目录（无凭据、不进 transcript，用后清理）。WAO 只 detect / invoke / report，
不生成、不升级、不持久修复该资产。能力边界（如实）：compose 层 `disabled` 是唯一真
containment，**不是 OS 级沙箱隔离**；wire 上的 deny-list tripwire（subagent/subagent_fork/
spawn_teammate）是**检测不是阻止**。该 backend 声明 `supportsSessionReuse=true`（2026-09-21
按 ADR-0031 §3.6 关联面落地 + 真实跨 run 恢复证据翻转）：关联面挂 transcript SSOT——
routing 条目记前任 WAO runId，resume 信封只携带该 runId（内部标识，非凭据），ACP sessionId
由 spawn 权威（runManager）按 runId 绑定读取器从前任何转录取回、in-process 送达 backend
（**绝不进 argv**）；关联缺失/损坏（路由条目损坏、前任 `session.created.backendSessionId`
缺失/空/非字符串）与上游 `session/resume` 拒绝（会话已消失、canonical workspace 不符）一律
**fail-closed 拒绝，绝不静默新建会话**；仅 stable-workspace lane 的非 delivery 派发开复用，
delivery 派发一律 fresh session。证据与复现：`scripts/reliability/dsh-acp/evidence/
phase6-session-reuse.json`（正负向）。**不支持在途纠偏**（`run_correct` 会被派发层拒绝，如实标注不静默）。
**reasoning.effort 条件可配（仅 low/high/max）**：Phase 5 实测（2026-09-20，dsh 0.1.5-rc.2，
`scripts/reliability/dsh-acp/evidence/phase5-config-option-set*.json`）证明 ACP 面的
`session/set_config_option` 可设置 `reasoning_effort`（set 响应 currentValue 确认生效；域外值
被 -32602 拒绝）。WAO 六值闭集 ∩ ACP 广告四档（off/low/high/max）= **low/high/max**——只放行
交集，其余（minimal/medium/xhigh/off）固定文案拒绝，不发明映射。派发时在 session/new 后经
`session/set_config_option` 下发，**响应未确认请求值即 fail-closed 拒绝派发**（不静默回退），
会话内留 system 转录事实。终局
token 用量来自 `session/prompt` 响应的 usage（实测可为 null——缺失即无 metrics 事实，
`usage_update` 上下文占用绝不计入 input）。认证走独立 lane（新 agentId + delta 档起，
ADR-0031 §4），经 `npm run reliability -- --agent <lane>` 认证前 registry 诚实显示
`certification:null`。

`registry validate` 的能力交叉 `⚠` warning（ADR-0025 批次 2，均不阻塞派发、不影响 exit code）：
validate 加载 backend **代码类**的闭集能力声明做纯静态交叉校验（只读类声明，不为校验启动任何
进程或网络请求）。配置 × 声明不符时两条提示：

- `tokenBudget` 配置 × 该 backend 类未声明 usage/token 上报（`reportsTokenUsage` 非 true，
  未声明按 false 读）→ `⚠` "配了 tokenBudget 但不生效"（TD-87：kimi-code stream-json 无
  usage 字段即此形状——WAO 预算闸门收不到 token 事实，成本兜底只剩 backend 自带控制；
  ADR-0030 起 `waitTimeout` 到期只通知不终止，不再构成成本兜底）。
- `sessionReuse` 配置 × backend 类未声明 `supportsSessionReuse`（未声明同样按 false 读，
  fail-closed）→ `⚠` 提示该派发会在 spawn 前被运行时硬门拒绝（TD-117 形状）；换声明支持的
  backend 或移除该配置。

两条都是提示层：tokenBudget 的运行时闸门与 sessionReuse 的 spawn 前 fail-closed 门
（`src/runManager.js`）语义不变——validate 只把不符提前到静态阶段并让它可见，不替代运行时拒绝。

> **勘误注记（2026-09-26 迁移时按 ADR-0032 §8 现行行为纠正）**：下段"pass + detail 明示 `not applicable`"是 2026-08-20（TD-87）时点的落地行为，**已被五态规则取代**——现行实现中 `metricsNonZeroCheck()` 不适用改记 **N/A + 原因**（`state:"not-applicable"`：不置绿、不算失败、满足必需类目的覆盖语义），kimi 形状 lane 不再因此落 `conditional`。原文保留为历史记录，不构成第二份当前规则；现行规则见下文「认证检查结果五态与能力轴分层」节。

**行为变更（2026-08-20，TD-87 认证面症状解除）——reliability 认证的 `metricsNonZero`
检查自起按 backend 能力声明条件适用**：判定源与上述 `⚠` 交叉校验同源（ADR-0025
批次 2 的 `backendCapabilitySnapshot`；纯内核 `scripts/reliability/metricsCheck.mjs`
消费）。backend 类声明不上报 usage（`reportsTokenUsage` 非 true——kimi-code 即此
形状）的 lane，此检查按"通过 + detail 明示 `not applicable`"落账：kimi 形状 lane 不再
因此落 `conditional`（此前该形状的 observability 检查被整个省略 → 必需类目缺失 →
每轮 conditional、`lastHealthyRunAt` 恒 null）。声明上报 usage 的 backend 断言**不变**
——`input` token 非空照常断言（它对这类 lane 是 parser 回归金丝雀：流格式变化致
metrics 投影断裂时第一时间红）。`CERTIFICATION_STATUSES` / required-categories 机制
不变，无新增 "skipped" 状态值；能力缺口事实由批次 2 声明 + validate `⚠` 独立承载。

## 接入新模型 / 新运行时（lane 内操作 vs Owner 决策）

**claude-code 舞道纯净模式（2026-09-19 Owner 裁定）**：backend 对**所有** claude-code worker 会话强制 `--bare --strict-mcp-config`（src/backends/claudeCode.js buildArgs 硬编码，非 registry 可选项）——全局 CLAUDE.md/技能/插件/hooks/MCP 一律不进 worker 上下文（skillUsage 实证 worker 期零使用，属纯 token 税）；角色合同仍经 `--append-system-prompt` 显式注入不受影响；认证经包装层 ANTHROPIC_AUTH_TOKEN 在 bare 下实测可用（run_20260919225953408ygpttq 哨兵三无验证）。未来任何 claude-code 驱动 lane 均默认继承此配置。

**第一分叉（先判断要的是哪一面，TD-161）**：

- **只换模型** = 改既有 backend 的 `provider`/`model` 字段——lane 内操作（组合权在 Owner：
  写 registry + 付认证费，见 docs/team-roles.md §Lane）。
- **明确要求另一 CLI/runtime 驱动** = 新 backend = Owner 决策（backend 闭集成员增补属
  Owner 裁量；曾评估未纳入的 runtime 先例见 ADR-0028）。provider 替代方案是否可接受由
  Owner 判断，**不得当成等价解**——provider lane 只解模型面（backend 不变），不构成
  "指定 CLI 驱动 runtime" 需求的满足。

**操作食谱（只换模型时）**：改 provider 块（`baseUrl`/`apiKeyEnv`）→ 设 env（Windows User
环境变量）→ smoke 首跑 → 承重前 delta 认证。认证档位规则与刷新触发面见 ADR-0029：同
backend 换 model/provider → `--profile delta`；换 backend / 升主力 lane → 全量重跑
（delta 规程详见下文「delta 认证规程」节）。

**换模型同步面 checklist（2026-09-17 实证八处，防"靠记忆同步"）**：改一条 lane 的
模型/provider 时逐项核对——① live `config/agents.json` 席位块；② 同文件认证矩阵行
（providerID/modelId/label）；③ `config/agents.example.json` 席位块+矩阵行；④
`docs/team-roles.md` 该角色 model 行（**历史 probe 实测表是冻结记录，不随当前模型改写**）；
⑤ `docs/usage.md` 中的配置示例（如有）；⑥ `AGENT_ONBOARDING.md` 引用（如有）；⑦ 相关
测试断言面（onboarding/modelFamily/docs-consistency 等——改漏会红，这是设计行为）；
⑧ 若涉及新增测试文件，`test/manifest.json` 登记。

**案例一行**：2026-09 zcode 事件——life-index CTO agent 接指令切模型（"ZCode 后端驱动"），
在 WAO 源码 grep `zcode` 零命中后停滞；判断本身正确（src/ 无 zcode 后端是 Owner 刻意
边界），裁定与重看触发器见 ADR-0028。

## backend 能力对照表（TD-162）

本节手写表体已退场（2026-09-22）：权威投影是生成层 **`docs/surface/certification.md`**——六轴能力闭集声明、配置表达力四轴判定（`validateAgentPolicy` 行为探针派生）与每 backend 条件说明、认证台账指针都在该文件，由 `npm run gen:certification` 从 `src/registry.js` / `src/backends/factory.js` 现成 SSOT 派生，字节钉由 `test/isolation-infra/docsSurface.test.js` 与 `test/isolation-infra/docs-consistency.test.js` 守卫；此处不再维护手写当前值副本（配了代码不能表达的值仍由各 backend `validateAgentPolicy` 在派发前 fail-closed 硬拒，语义见生成文件判定词）。

## 上游 harness 原语对照（实测）

上表判定词只管 **WAO 接线层**，所以「不支持」会掩盖三种截然不同的成因。本节把「上游到底有没有」的事实单独立表——2026-09-21 就是这么误读的：codex / kimi-code 的 headless 复用被读成「不存在」。

> **基线日（as-of）：2026-09-21**；**刷新期限：90 天**（超期由 `test/isolation-infra/docs-consistency.test.js` 的 TD-184 守卫直接变红，不靠人记）。**事件触发优先**：同一 harness 升级、WAO 适配层改动、新 harness 入册，都必须当场刷新本节与基线日。

| backend | 上游会话续接原语 | 实测（as-of 当日） | 上游在途消息原语 | 实测 |
|---|---|---|---|---|
| claude-code | `--session-id` / `--resume` | 已接线（组合层认证在册） | stdin stream-json 排队 | 已接线（唯一 supportsInFlightCorrection=true） |
| codex | `codex exec resume <thread_id>`（会话标识来自 `thread.started.thread_id`；另有 `codex fork`） | **已接线**（2026-09-21，`supportsSessionReuse=true`）；上游正向跨 run 携带上下文、错 id → `no rollout found` exit 1（直跑实测） | `codex queue`（给已有 session 排队消息） | 未测（是否能在活 turn 中生效未知） |
| kimi-code | `kimi -r <session_id>`（stream 内 `session.resume_hint` 广告；另有 `-S/--session`、`-c/--continue`、`kimi fork`） | **已接线**（2026-09-21，`supportsSessionReuse=true`）；上游正向跨 run 携带上下文、错 id → `Session "…" not found` exit 1（直跑实测） | 未测（无对应文案） | 未测 |
| deepseek-harness | 未测（旧 dsh 原生通道；WAO 侧声明 false） | — | 未测 | — |
| deepseek-acp | ACP `session/resume` | 已接线（ADR-0031 §3.6 + phase6 真实恢复证据） | 上游无（ACP 无在途消息改写，F7 实测） | 上游无此能力 |
| opencode-serve | 未测（serve 持有 session 概念；WAO 侧未接线） | — | 未测（HTTP 双向，理论可注入） | — |

**读法**：①「未测」是**未测**，不是「没有」——期限就是用来逼这些格子在值得填的时候被填掉；②**复用只在 MCP 通道可用**：CLI 后台通道刻意每次派发用一次性 leadSession（`src/commands/run.js` 注释：one-shot 进程没有稳定 Lead 会话），所以 CLI 派发的复用 agent 永远走首轮——真正的跨 run 复用只有 MCP（稳定 leadSession）能给；②已实测可复用的 codex / kimi-code 仍记 `sessionReuse` 不支持，因为接线要的是 WAO 侧关联面（resume 信封只带前任 WAO runId、sessionId 由 WAO 从转录取回、关联缺失即 fail-closed 拒绝，形状见 ADR-0031 §3.6）加真实跨 run drill 证据，见 TD-184。

> **勘误注记（2026-09-26 迁移时按 TD-184 现状纠正）**：上段"②"中"已实测可复用的 codex / kimi-code 仍记 `sessionReuse` 不支持"为**接线前（2026-09-21 之前）的历史**。当前 codex / kimi-code 的 backend 类声明均为 `supportsSessionReuse=true`（2026-09-21 已接线：resume 关联面 + parser 捕获 `thread.started.thread_id` / `session.resume_hint` + 终态前补记绑定 `session.created`）；剩余缺口是真实跨 run 恢复的端到端证据（组件层正向证据登记，见 TD-184）。

## 认证与转录维护命令（原 usage「验证安装」迁出部）

原「验证安装」代码围栏中的 registry list / registry check 命令仍留在 `docs/usage.md`；以下为 smoke、runtime certification 与 drill 转录维护命令（围栏两侧在本文件与 usage 各自补齐）：

```powershell
# 跑一次真实 smoke（消耗真实 API token）
npm run smoke           # 自动探测 claude/codex
npm run smoke -- claude # 只测 claude
npm run smoke -- --isolate  # 测 worktree 隔离

# 跑 runtime certification（消耗真实 API token）
npm run reliability
npm run reliability -- --profile strict
npm run reliability -- --profile delta   # delta 子集（新 lane 先行认证，见下节）

# 维护：清理未被 reliability-summary 引用且超龄的 drill 转录（零 token；发布路径零删除后显式触发）
node scripts/wao-node.cjs scripts/reliability/prune-drill-transcripts.mjs --dry-run
node scripts/wao-node.cjs scripts/reliability/prune-drill-transcripts.mjs --max-age-days 7
```

## delta 认证规程（lane 架构，ADR-0025 批次 3）

新（harness × 模型）组合（新 lane）先用 delta 子集认证，通过后再全量重跑升级：

- **delta 子集** = `sentinel` + `scorecard` + `adversarialEscape`（越界写对抗）。`adversarialEscape`
  是负向 drill：任务 prompt 明确指示 worker 往授权路径之外写一个文件（worktree 父目录），断言
  delivery containment gate 拦截——transcript 出现 `run.isolation_violation{code:"workdir_escape"}`
  （和/或 `run.error{phase:"isolation", code:"workdir_escape"}`）且 run 终态 `failed`。isolation
  语义由该 drill 承担（双席顾问一致要求 isolation 类不得省）；**不含** workflowRunDir。配置：CLI
  `--profile delta`，或在 `certification.matrix` 行写 `"profile": "delta"`；行内显式 `drills`
  覆盖仍生效（覆盖后恰为 delta 子集的行同样按 delta 规程读——按实际覆盖派生，保守；
  R23-C 起 `profile:"delta"` 不再短路：行内显式 `drills` 一旦超出 delta 子集，该 case 按
  **full** 记——scope 反映实际覆盖，不反射 profile 标签）。
- **adversarialEscape 的 PASS 语义**：判定证据是拦截事实，**不是**产出文件存在/不存在。逃逸未被拦
  （文件真写出来、run 正常 completed、无 workdir_escape 事实）→ drill 红（防假阳性：没有拦截证据
  就不得宣称拦截能力；worker 拒绝配合执行越界写指令时同样红——需人工分辨"机制失效"还是"模型没
  配合"）。拦截是侦测机制不是 OS 沙箱（R4 诚实上限）：`file_written` 事后证据路径下越界文件可能
  已落盘——落盘与否只进 check detail，不作 PASS 判定。该 drill 与其他 drill 一样消耗真实 token、
  按 matrix 行配置启用。
- **通过 → `conditional` + `certificationScope:"delta"`**：delta 子集全过**不产生** `certified`。
  `runs/reliability-summary.json` 的 worker 记录取 `status:"conditional"` + 事实字段
  `certificationScope:"delta"`（按该 worker case 的 profile/drill 覆盖派生，混合取保守值
  "delta"）。`CERTIFICATION_STATUSES` 闭集不变；scope 只活在磁盘 summary + 本文档层，**不进**
  CLI `registry list` / MCP `registry_list` 投影——wire 上该形状的 `certificationReasonCode` 为
  `null`（闭集无 delta 码，为保 MCP 面零改动不加码，不伪造近似码）。
- **全量重跑升级**：对目标 worker 重跑全量（`npm run reliability -- --agent <id>`，不带
  `--profile delta`，或 strict 行），`mergeCaseResults` 以 caseId 为键增量合并——本次全量 case
  覆盖同 caseId 的旧 delta case，status 升 `certified`、scope 升 `"full"`；未重跑的其他 worker
  结果保留。
- **监督口径（ADR 0018 措辞纪律）**：`conditional` 的 `recommendedUse` 显示值是
  `supervised-dispatch`，"监督" = Lead 人工盯，**无机制保障**——不存在自动监督档、自动降级或
  自动限制机制。P1-1 门（显式 `--require-certified`）对 conditional 照常放行（core 全过即放行
  的既有阈值），身份比对与 per-worker 新鲜度判定同等适用。

## 认证检查结果五态与能力轴分层（ADR-0032 §8，2026-09-21）

**检查结果五态**：reliability / component-check 的检查（check）结果是闭集
`pass / fail / not-applicable / blocked / inconclusive`（词汇模块
`scripts/reliability/checkStates.mjs`，两层共用；检查级字段名是 `state`——绝不叫
`status`，那是组合层保留词）。判定纪律：

- **N/A 必须有原因**（`stateReason` 非空，缺原因在构造与磁盘两侧都被拒绝）；
- **N/A 不置绿、不算失败、不贡献能力绿**——`certifyCase` 的 `capabilities` 聚合跳过
  N/A 检查（该能力轴不被断言，summary 里不再出现 `metrics:true` 这类伪造绿）；N/A
  满足必需类目的【覆盖】语义（检查跑了、如实话不适用——TD-87 的 kimi 症状解除由
  此保留，lane 不再因此落 conditional）；全 N/A 的 case 触发零正向证据守卫（不得
  certified）。组件层 `componentResultFromChecks` 同纪律：judged 检查全
  {pass, N/A} 且至少一条 pass 才 pass。
- **blocked**（检查级外部阻塞）映射 case 级 `blocked`；**inconclusive** 不覆盖类目
  （fail-closed 降 conditional）。
- 五态化修掉的既有坏模式（ADR-0032 §8 点名五处，全落在 2026-09-21 批次）：
  `metricsNonZeroCheck` 不适用改记 N/A（原 `pass:true, capability:"metrics"`）；
  `silentTimeout` 在 serve 不可达时记 N/A + 原因（原"skip 顶绿"）；`hasSentinel`
  只认 **assistant 回显**（原对所有 message 做子串搜索——tool_result/用户消息里
  搜到不算回显）；`runStrictScorecardDrill` 的文件证据升级为**存在 + 内容承载
  sentinel**（原只查存在）；`scorecardChecksFromResult` 缺 scorecard 时**记红**
  （原用 `completed` 顶替证据检查）。逐处改动对在册 worker 记录的影响评估见
  `docs/research/2026-09-21-adr0032-five-state-impact.md`。

**`reportsCommandExitCode` 诚实声明（只声明，不放行）**：backend 类新增第六个能力
声明成员，语义 = **WAO 今天能否产出命令退出码证据**（含 scorecard 的
toolCallId↔tool_result 0/1 推断通道，非仅 wire 原生数值）。当前声明：codex /
opencode-serve（wire 原生数值）、claude-code / kimi-code / deepseek-harness（可靠
推断通道）为 true；**deepseek-acp 为 false**——静态核查
（`scripts/reliability/dsh-acp/evidence/phase7-exit-code-wire.json`，零 token）证明
dsh-acp 0.1.5-rc.2 的 `tool_call_update` 不填协议自带的 `rawOutput`，退出码只以
`[exit code: N]` 自由文本标记出现且仅非零退出有痕。声明 false ⇒ strict/scorecard 的
`commandsPassed` 类检查在证据不可取得时记 **N/A + 原因**（不置绿、也不算失败）；
若 scorecard 已明确观察到非零退出则保留真实 fail。必需 strict 轴为 N/A 的 case 保持
`draft-only`，不能仅靠能力声明进入可派发集合；任何放宽都须 Owner 另行显式裁定。

**被测 harness 的运行时身份入账**：组件层认证入口（`npm run component-check`）对每个
backend 被测恰一次实际执行前缀的版本探测（`agent.binary` 优先，保留
`agent.prependArgs`，再附 `--version`；`scripts/reliability/runtimeIdentity.mjs`，零新依赖），
把 `runtimeIdentity`（`distribution` / `version` / `binaryPath` / `fingerprint` /
`verified` / `reason`）记进组件记录；组件键升级为 `backend:<name>@<codeRef>#<runtimeFingerprint>`。
**只做 advisory/stale 可见性**：版本漂移 → 同 (name, codeRef) 的历史记录降
`runtime-drifted` advisory「建议重跑」（不删）；不进认证门、不加 registry schema
字段。探测失败或无本地二进制时明确 `verified:false`，指纹按探测目标稳定派生为
`unverified-v1-*`：这只避免同一未验证目标每次制造新键，绝不表示运行时身份已验证。
opencode-serve 是 HTTP 服务 backend，因此保持稳定的未验证身份。

**能力轴分层骨架**（组件层 / 组合层各测什么——全表按需扩充，本节只定层）：

- **组件层轴**（`npm run component-check`，backend/llm 单独验证，零承重）：
  1. **声明闭集双向一致性**——`readBackendCapabilities` 的六轴闭集
     （`supportsRoleContract` / `supportsSessionReuse` / `supportsInFlightCorrection` /
     `replayByRespawn` / `reportsTokenUsage` / `reportsCommandExitCode`）逐轴对账：
     declared=true ⇒ 正向实测证据（sessionReuse 须真实跨 run 恢复证据——dsh 用
     `scripts/reliability/dsh-acp/evidence/phase6-session-reuse.json`，未登记证据的
     backend 如实红；roleContract 须合同内 marker 的模型回显；exitCode 须探针 run 的
     scorecard commandsPassed；tokenUsage 须 input 双向一致）；declared=false ⇒ 配置面
     必须明确拒绝（systemPrompt / sessionReuse 的 spawn 前硬门探针）或按既定纪律记
     N/A（exitCode / 无配置面的轴 + 原因）。
  2. **生命周期 / 投影完整性**——启动与配置传递（不支持参数明确拒绝）、正常完成 /
     启动失败 / 中途错误 / 等待到期 / 显式停止（按执行形态分车道）、事件与证据转换
     （缺字段/乱序/重复/断流不制造成功证据）。零真实模型即可判定其中大部分探针
     （拒绝类探针在派发前失败）。
- **组合层轴**（`npm run reliability`，按席位 agentId 认证，承重）：交互闭环——
  `complete`（完成诚实）/ `assistantText`（非伪完成）/ 证据族（`commandEvidence` /
  `fileEvidence` / `toolEvidence` / `fileMaterialized` / `readFiles` / `metrics`）/
  `adversarialEscape`（越界写拦截）等 case 级能力，产出 certified/conditional
  台账（`runs/reliability-summary.json`）。
- **配置表达力四子轴**（model / reasoning / contextWindow / provider）**不在本节
  复制**——权威源是生成层 `docs/surface/certification.md`（TD-162 投影落点；
  `npm run gen:certification` 从 backend 代码派生，字节钉由
  `test/isolation-infra/docsSurface.test.js` / `docs-consistency.test.js` 守卫）；
  此处复制会制造第二份会漂移的真相源。

**认证证据绑定执行画像 + 只读适用性三态（TD-186，2026-09-22；同日复核收口）**：
组合层认证（`npm run reliability`）新写入的 case 记录实际生效的执行画像——`modelId` /
`providerID` / `providerKey` / `effort`（取自该 lane 的 registry 配置，与派发同源）、
`runtime`（复用 `runtimeIdentity.mjs` 探测，探不到如实 `verified:false`）、`codeRef`
（git HEAD 只读获取）、`capturedAt`、各 drill 的 `runId`（`drillRunIds`；drills.mjs
不上抛内部 runId 的 drill 如实记 `null`；派发失败占位 `unknown` 同样归 `null`）。
**drillRunIds 取证闭环（复核 FAIL-B）**：sentinel/scorecard 的 run 转录持久化在
`runs/reliability/<runId>.jsonl`（runs 归档清扫只处理顶层 `*.jsonl`，子目录语料不在
清扫面内），每个 id 可独立回查；写 summary 前逐 id 守卫（fresh id 缺转录 = 拒绝
写盘并非零退出——绝不记录指向已删除/不存在证据的 id），旧版取证遗留的悬空 prior id
写盘前如实置 `null` 并告警。**发布路径零删除（2026-09-22 审计收口：交错发布误删
证据）**：生成/发布 summary 的路径只写不删——旧版写盘后按【进程内】summary 的引用集
清理，与其他发布者不协调（A 写→B 写+清理→A 恢复清理 ⇒ 最终 summary 引用的转录被
删；B 写完中断、A 再收尾亦复现）。删除唯一入口 = 显式维护步骤
`node scripts/wao-node.cjs scripts/reliability/prune-drill-transcripts.mjs [--max-age-days <n>] [--dry-run]`
——删除前**重新读取磁盘上的当前 summary**，只删「未被任何条目引用 且 超过年龄阈值
（默认 7 天）」的转录；被引用的绝不删（无论多老）；summary 缺失/不可解析时一个都
不删（fail-closed）。**增长有界是带条件的**：仅当该维护步骤被例行执行（建议与
runs 清扫 runbook 同频，且维护时无进行中的 reliability 运行——年龄阈值只是维护
步骤自身 TOCTOU 窗口的兜底，不是并发协调机制）时，`runs/reliability/` 才收敛到
「当前 summary 引用集 + 阈值年龄窗口内」的转录量；无人执行维护时目录只增不减
（重认证不断产生被取代的转录），维护中被锁跳过的文件依赖下一次维护，不自动收敛。
旧记录不补猜值（缺画像即 unknown）。查询
侧：`registry list --cert-evidence`（text 追加详情块 / `--format json` 附
`certificationEvidence` 数组，与 `registry_list` 共用
`src/application/registryInventory.js` 服务）按席位分列展示**声明 / 组件观测 / 组合
结果 / 证据适用性 / 限制与来源**，**取证时间在两处渲染里保留**（组件观测行携带
`lastVerifiedAt`；组合列携带画像 `capturedAt` 与全绿 `lastFullHealthyRunAt`，
后者**缺席时两路统一渲染 `lastFullHealthy=?`**——缺席显示 `?`、不整项省略
（audit11 缺口 2 收口，与 `lastVerifiedAt`/`capturedAt` 的缺席约定一致）；
`--format json` 的服务行保留全部原始时间戳字段——渲染层不得丢弃取证时间）；
台账来源状态（缺文件 / 不可解析 / 读取错误）分别
可辨，不复用有损吞错的简表路径；`drillRunIds` 记录了 id 但对应转录不在回查位置时
浮出 `drill-evidence-unresolvable` 限制项（不改三态）。**自然时效限制项（audit11
缺口 1 收口，2026-09-23）**：组件观测除复制磁盘 `advisory.code` 外，还按
`componentLedger.mjs::classifyComponent` 的时间维**现算**自然过期——组件记录自身
`lastVerifiedAt` 超 30 天新鲜期（或缺时间戳不可证新鲜，fail-closed 同判）→
`component-expired:<n>`；夹具资格自然过期（`qualifiedAt` 超 30 天或
`ownerValidUntil` 已过、且未预标注）→ `component-fixture-decayed:<n>`。两类未预
标注的自然过期在 CLI 与 MCP 两路都显示为**限制项**（措辞不淡化成"无"；只是
advisory 提醒，不改三态、不进门禁），且组件限制汇总（来源状态/blocked/advisory/
自然时效）在**所有适用性路径**（matched / mismatched / undeterminable）都执行——
非 matched 的早返回不得吞掉组件侧并列事实（audit12 F1 收口，2026-09-23：组件过期
+effort 不匹配、夹具过期+legacy 无画像、组件过期+组合无记录/读取错误三组反例逐条
回归钉两路）。阈值常量在 src 侧以同值常量镜像
（layering 冻结 `src/**` 不得 import `scripts/**`），由
`test/registry-roles/certificationEvidenceInventory.test.js` 的**等值钉**守恒
（测试同时 import 两侧，常量或边界漂移即红）；owner 期限**等号边界**已纳入等值钉
（audit12 F2 收口，2026-09-23：`now === ownerValidUntil` 仍有效——严格大于才过期，
双侧同判；改任一侧（或两侧同时）等号语义 `>`→`>=` 该钉必红）。**证据适用性是三态闭集
`matched / mismatched / undeterminable`，判定 fail-closed（复核 FAIL-A：不复用
`matchedCertRecord` 的缺字段容忍——那是派发门"旧记录不误杀"的取舍，取证路径缺身份
就是无法证明）**：记录的 executionProfile 身份四元组（`modelId`/`providerID`/
`providerKey`/`effort`）不完整（`modelId`/`effort` 须非空字符串；`providerID`/
`providerKey` 须非空字符串或 `null`=已观察无接入方）、画像不明（legacy 记录无执行
画像）或台账来源不可用/无记录 → `undeterminable`；四元组与当前声明不一致（含
provider 一侧 `null` 一侧非 `null`）、与记录顶层身份矛盾（如
`executionProfile.modelId` ≠ 顶层 `modelId`）、或 effort 不同 → `mismatched`；全等 →
`matched`。**`undeterminable` 绝不算绿**，且该列**绝不**与
组件/组合结果合并派生"总体可用=true"——只读展示，不改派发门（`--require-certified`
与 `matchedCertRecord` 语义不变；effort 纳入派发身份是 Owner 级决定）。
MCP 侧同款按需投影（ADR-0032 修订 2026-09-22，Owner 裁定）：`registry_list` 传
`detail:"certificationEvidence"` 时返回可选 `certificationEvidence` 行（同一服务、
五列与来源状态保真；默认调用一字不变；advisory-only，`requireCertified=false`
与 CLI 门禁语义原样）。

**认证更新的触发器与执行人**（ADR-0032 附则呼应；不改代码行为，只定规程）：

- **更新频次 = 事件触发为主**：① 上游运行时版本变更（操作员升级 claude/codex/kimi/
  dsh 等后——组件层入口的 runtimeIdentity 探测会把版本漂移显式标成 advisory）；②
  WAO 适配代码变更（backend/parser 改动 = codeRef 滚动，旧组件键自然过期）；③
  **席位有效配置变化（model / reasoning / provider）**：Lead 判断影响面 → 安排该席位
  **定向重验**（重跑其认证 case），或**明确记录暂缓及使用限制**（何时补验、在此之前
  该席位按什么范围降级使用）。配置变更后的旧证据不自动适用（TD-186：新证据记录
  执行画像，只读适用性三态见上一段）。
- **时间窗兜底**：沿用 `componentLedger.mjs` 的 `DEFAULT_MAX_AGE_DAYS=30` 作为**审阅
  提醒**（超期记录消费为 stale advisory）——**不**做每月无差别全量重跑；30 天窗是
  **组件记录的审阅提醒，不能替代配置变更后的影响判断**（记录未超期 ≠ 对新配置适用）。
- **派发报错是最后防线**：派发失败只记回归信号（组件层红 = 新鲜度分叉），**不**
  自动耗 token 重考。
- **执行人**：**操作员**负责安装/升级 runtime；**Lead** 界定影响面并调度重验（哪个
  backend/组件受版本漂移影响、要不要跑 component-check / reliability）；**Owner**
  决定新增组合、费用与承重用途。
- **组件层不进派发门禁**（ADR-0032 Consequences：诊断/初筛语义）——组件结论是
  advisory 证据，绝不是 permission gate。

## 场景 1b：单次派发换模型（--model，R10-A）

"这一次任务的会审选用 codex CLI 驱动的 gpt-5.6-sol-xhigh" 这类**单次生效、不落配置**的模型覆盖：

```powershell
# 前台：立即回显 effective model，然后照常等待并打印摘要
npm run cli -- run coder_low --prompt "..." --model gpt-5.6-sol-xhigh

# 后台：JSON 里带 model 字段（派发时刻即见，不必等 provider）
npm run cli -- run coder_low --prompt "..." --background --model gpt-5.6-sol-xhigh
```

语义要点：

- **只替换 `model.id`**：注册表里 model 是嵌套对象（canonical `{id, contextWindow?}`；opencode-serve 是 `{providerID, id, variant}`）。覆盖只改 `.id`，兄弟字段（contextWindow / providerID / variant）全部保留；注册表没有 model 的 worker 会合成出 `{id}`。合成发生在 `validateAgentPolicy` 与 `run.started` 落盘之前——策略校验照常跑合成后的对象，`run.started` 的 `model` 字段即合成后策略，并**另加显式 `modelOverride` 字段**（审计可区分"改注册表"与"一次性覆盖"）。
- **回显 effective model**：前台 text 格式在派发成功时打印一行 `effective model: {...}`；`--format json` 把同一对象作为结果里的 `model` 字段；后台 JSON 输出带 `model` 字段。**失败模式**：WAO 不校验模型 id 是否真实存在——打错的模型名要到 provider 期（worker 启动后）才报错，回显就是让你在派发时刻立刻看见打错了什么（回显是 advisory：展示的是 WAO 实际下发了什么，不证明 provider 接受该 id）。
- **resume 继承覆盖事实（R10-C C-1）**：`resume`（含 daemon `--resume-on-start` 接管）从 `run.started.modelOverride` 同源重建覆盖——后台派发带 `--model` 后 runner 崩溃、daemon 接管续跑时，后半程仍跑派发时的模型，transcript 里的覆盖事实不再失真。合成与形状门与 start 同一道（只替换 `.id`；持久化值非法则拒绝 resume，fail-closed）；resume 不接受调用方新传的覆盖。
- **两道硬互斥（fail-fast，零副作用）**：
  1. `--model` × `--require-certified`（闭集码 `model_override_certified_conflict`）：无条件互斥——认证矩阵按 provider+model 组合记录，任何覆盖（即使值与注册表一致）都使"已认证组合"声明失效。CLI 在 argv 边界早拒；`RunManager.start` 顶部作权威拒绝（前台/后台/workflow/daemon 全通道同一语义）。
  2. `--model` × provider-session 复用派发（闭集码 `model_override_reuse_conflict`，typed `ModelOverrideConflictError`）：reusable expert（`sessionReuse: "lead_workspace"`）与 continuable delivery 谱系根两形状都拒——跨回合续用的 provider 会话必须跑同一个模型（resume 侧只从 `run.started` 重建该 run 自己的覆盖事实、不接受调用方新传覆盖，R10-C C-1；派发时再换模型会破坏 provider 会话契约）。dispatchRun 在路由槽/transcript/fork 之前拒绝。
- **正交放行**：`--model` × `--read-only` 可同用（金丝雀换模型试跑是合理用法）；`--model` × `--delivery-spec-file`（及 MCP `delivery` 块）放行，但注意**该 run 的认证组合声明失效**——reliability 认证按注册表的 provider+model 组合记录，覆盖后的组合未经认证；override 事实已由 `run.started.modelOverride` 入 transcript 供审计。
- **形状门**（对齐 canonicalAgentId 纪律）：非空 string、长度 ≤128、不以 `--` 开头、不含空白/控制字符。`--` 前缀规则是承重的——后台 runner 的 `parseSimpleFlags` 会把 `--` 开头的值当下一个 flag，值对会静默断裂。违规以固定文案 fail-fast（不回显原值）。MCP `run_dispatch` 的 `model` 参数走同一 SSOT（wire schema 正则与核心校验器同源）。
- **排除边界**：`--model` 只存在于 `run`（含 `--background`）与 `retry`（retry 上为替换继承值，见下文「retry 的 per-dispatch 覆盖继承」节）。`spawn` 显式拒绝（多席统一模型语义混浊，Owner 场景是单派发）；workflow agent 节点与 daemon 派发不解析该 flag——声明式表面的模型应写进声明本身（注册表 model 策略）。持久换模型 = 改注册表，不是加 flag。

（MCP 面）**R10-A 单次模型覆盖（可选，`model`）**：`run_dispatch` 顶层可带 `model`（`"model": "<modelId>"`，CLI 等价 `run --model`，完整语义见上文「场景 1b」节）——单次生效、不落注册表、只替换注册表 model 的 `.id`（contextWindow/providerID/variant 保留），wire schema 与核心校验器同源（非空、≤128、不以 `--` 开头、无空白/控制字符）。互斥与放行：× provider-session 复用（reusable expert / continuable 谱系根）以固定文案拒绝（闭集码 `model_override_reuse_conflict`——"A per-dispatch model override cannot be combined with provider-session reuse … must run one model"）；认证互斥（closed-set `model_override_certified_conflict`）在 MCP 侧不可达——`requireCertified` 恒为 server-owned `false`，认证矩阵（provider+model 组合的 certified 记录）只在 CLI 显式 `--require-certified` 时被求值；× `delivery` 块放行，但**该 run 的认证组合声明失效**（认证按注册表 provider+model 组合记录，覆盖后的组合未经认证）——override 事实由 `run.started.modelOverride` 入 transcript 供审计。派发成功不回显 effective model（MCP 输出 schema 冻结为闭集字段）；打错的模型名要到 provider 期才报错，需即时确认时读 transcript 的 `run.started.model`。

## 场景 1c：单次派发换推理力度（--reasoning，R11-1）

"这一次会审用 gpt-5.6-sol 配 xhigh 推理力度" 这类**单次生效、不落配置**的推理力度覆盖（与 `--model` 可同用）：

```powershell
# 前台：立即回显 effective reasoning（与 --model 同用时合并为一行 effective 回显）
npm run cli -- run coder_low --prompt "..." --reasoning xhigh

# 与 --model 同用（Owner 场景 "gpt-5.6-sol + xhigh"）
npm run cli -- run coder_low --prompt "..." --model gpt-5.6-sol-xhigh --reasoning xhigh

# 后台：JSON 里带 reasoning 字段（派发时刻即见，不必等 provider）
npm run cli -- run coder_low --prompt "..." --background --reasoning xhigh
```

语义要点：

- **只替换 `reasoning.effort`**：注册表里 reasoning 是嵌套对象（canonical `{effort}`）。覆盖只改 `.effort`，合成发生在 `validateAgentPolicy` 与 `run.started` 落盘之前——策略校验照常跑合成后的对象；`run.started` 的 `reasoning` 字段即合成后策略（R11-1 起无条件落盘——今天起也补上**静态** reasoning 的审计缺口），并**另加显式 `reasoningOverride` 字段**（审计可区分"改注册表"与"一次性覆盖"）。
- **闭集值域**：`minimal / low / medium / high / xhigh / max`（`registry.js` 的 `REASONING_EFFORTS` SSOT，六值导出）。集外值（含大小写变体如 `HIGH`）以固定文案 fail-fast（不回显原值）。MCP `run_dispatch` 的 `reasoning` 参数走同一 SSOT——wire schema 直接序列化闭集枚举（比正则更严）。
- **无能力布尔（设计决策）**：不可表达（opencode-serve 拒绝任何 `reasoning.effort`）与条件不支持（kimi 仅 K3 模型 × {low,high,max}；deepseek-harness 仅 high|max）都走**既有 per-backend policy 门自然拒绝**——合成后的对象照常过 `validateAgentPolicy`，拒绝时追加指对 `--reasoning` 旗标的固定提示句（不回显值）。平面"能力布尔"编码不了这些条件支持，故不设。
- **与 `--model` 可同用**：两个覆盖各改各的字段（`.id` / `.effort`），互不干扰；前台回显合并为一行 `effective model: {...}, reasoning: {...}`（advisory：展示 WAO 实际下发了什么，不证明 provider 接受）。
- **resume 继承覆盖事实（R11-1）**：`resume`（含 daemon `--resume-on-start` 接管）从 `run.started.reasoningOverride` 同源重建覆盖——后台派发带 `--reasoning` 后 runner 崩溃、daemon 接管续跑时，后半程仍跑派发时的力度。合成与闭集门与 start 同一道；持久化值非法则拒绝 resume（fail-closed，零 re-spawn）；resume 不接受调用方新传的覆盖。
- **两道硬互斥（fail-fast，零副作用，"任一覆盖在场即拒"）**：
  1. `--reasoning` × `--require-certified`（闭集码 `reasoning_override_certified_conflict`）：无条件互斥——覆盖改变认证组合被测量时的执行包络，任何覆盖都使"已认证组合"声明失效。CLI 在 argv 边界早拒；`RunManager.start` 顶部作权威拒绝。
  2. `--reasoning` × provider-session 复用派发（闭集码 `reasoning_override_reuse_conflict`，typed `ReasoningOverrideConflictError`）：reusable expert 与 continuable delivery 谱系根两形状都拒——跨回合续用的 provider 会话必须跑同一推理力度。dispatchRun 在路由槽/transcript/fork 之前拒绝。**组合策略拒绝指对旗标**：`--model` 与 `--reasoning` 同用时撞复用，model 冲突先拒（确定性顺序，runDispatch.js 注明）；policy 门拒绝的提示句按在场覆盖组三种形状（仅 model / 仅 reasoning / 双覆盖）指对旗标。
- **正交放行**：`--reasoning` × `--read-only` / × `--delivery-spec-file`（及 MCP `delivery` 块）可同用（同 `--model` 的认证组合声明失效注意事项）。
- **排除边界**：`--reasoning` 只存在于 `run`（含 `--background`）与 `retry`（retry 上为替换继承值，见下文「retry 的 per-dispatch 覆盖继承」节）。`spawn` 显式拒绝；workflow agent 节点与 daemon 派发不解析该 flag——声明式表面的推理力度应写进声明本身（注册表 reasoning 策略）。持久换力度 = 改注册表，不是加 flag。

（MCP 面）**R11-1 单次推理力度覆盖（可选，`reasoning`）**：`run_dispatch` 顶层可带 `reasoning`（`"reasoning": "minimal"|"low"|"medium"|"high"|"xhigh"|"max"`，CLI 等价 `run --reasoning`，完整语义见上文「场景 1c」节）——单次生效、不落注册表、只替换注册表 reasoning 的 `.effort`，与 `model` 参数可同用（Owner 场景 "gpt-5.6-sol + xhigh"）。wire schema 直接序列化闭集枚举（`registry.js` 的 `REASONING_EFFORTS` SSOT 经 runDispatch 下向 re-export——zod enum，比正则更严，与核心校验器零漂移）。互斥与放行：× provider-session 复用以固定文案拒绝（闭集码 `reasoning_override_reuse_conflict`——"A per-dispatch reasoning effort override cannot be combined with provider-session reuse … must run one reasoning effort"）；认证互斥在 MCP 侧不可达（同 `model` 的 server-owned `false` 构造）；× `delivery` 块放行。不可表达（opencode-serve）与条件不支持（kimi K3-only、dsh high|max）组合走既有 per-backend policy 门自然拒绝。**`run_dispatch_contract_check` 共享该输入 schema 但有意忽略 `reasoning`**（它只就 delivery 合同给 advisory——与对 `model` 的忽略同一先例）。派发成功不回显 effective reasoning（MCP 输出 schema 冻结）；需即时确认时读 transcript 的 `run.started.reasoning`。

## retry 的 per-dispatch 覆盖继承（R12，与 resume 重建链对称）

- **任务文本取法（R13-C / TD-127）**：retry 派发的任务文本取**本 run 最后一条 `prompt.sent` 记录（纯 runId 绑定）**——尾部追加的跨 runId 伪造记录不采信（信封绑定纪律，读取器 SSOT 在 `transcript.js` 的 `findLatestBound`/`findFirstBound`）；合法双写形状（TD-54：spawn 前首写 + spawn 后补写）仍取最后一条。诚实边界（R13-C 统一口径）：绑定只杀跨 run 注入与错读——同 runId 的伪造追加（无论是否带 `messageId`）仍会被采信；该攻击面等同于持有 `runs/` 写权限，读取端无解，真边界在写入端完整性。R13 曾加"优先取带 `messageId` 的末条"收窄，R13-C 移除：claude-code/codex/kimi-code 均为 ProcessBackend 家族，其合法双写落盘**均无** `messageId`（spawn 结果的 `undefined` 经 JSON 序列化丢键），该收窄对此家族是死代码。
- **行为变更（R13 / R13-C 文案如实化）**：信封时代之前的 legacy transcript（事件无 `runId` 字段）经绑定读取器找不到本 run 的 `prompt.sent` → retry **硬拒绝**（文案如实覆盖两情形："no runId-bound prompt.sent found in this transcript — pre-envelope legacy formats are not retryable through the bound reader; re-dispatch explicitly with `run`"）；`resume` 对无信封 legacy transcript 同样拒绝（return null，与 resume 既有拒绝语义一致）。R18（TD-128 W3）起 resume 的**终态门**同款 runId 绑定——尾部追加的外 run/伪造 `run.state_change` 不再把 terminal run 的拒绝翻成接续、也不再误拒合法续接；legacy 拒绝语义（null）不变。
- **继承范围（诚实口径，R12-C）**：retry 重新派发**任务文本与 per-dispatch 覆盖**；delivery 声明 / 只读声明 / 隔离形状**不**继承（R12 前既有行为不变）——需要完整形状时用 `run` 显式重发。
- 源 run 的 `run.started.modelOverride` / `run.started.reasoningOverride` 事实会被**原样继承**到新派发——权威是**首条绑定该 runId 的 `run.started`**（transcript 信封绑定纪律，与 resume 的首条取法同族；尾部追加的伪造 `run.started` 即使形状合法也不采信）。值仍过 `run` 既有的形状门/闭集门与合成入口——新 run 的 `run.started` 落同样的覆盖事实。源 run 无覆盖且未显式给 flag → 零覆盖（与旧输出逐字节一致）。
- **旧格式宽容（R12-C）**：源 transcript 缺 `run.started`（R10 前旧格式）→ retry 按**零覆盖**放行，不拒绝——与 resume 的拒绝语义不同但各自正确（resume 要接续同一会话，找不到事实只能拒绝；retry 是全新派发，零覆盖即注册表策略）。
- `--model <id>` / `--reasoning <effort>` **显式替换**对应继承值（校验与 `run` 同源：模型 id 形状门 + effort 六值闭集 `minimal/low/medium/high/xhigh/max`）；不给 flag 则用继承值。
- **坏持久化值 fail-closed 拒绝**：源 transcript 的覆盖值损坏（非字符串/空/`--` 前缀/含空白/超长、或 effort 集外）时 retry 直接拒绝（固定文案指向源 run，`retry_inherit_model_invalid` / `retry_inherit_reasoning_invalid`，零新 transcript）——绝不静默忽略、绝不静默降级回注册表模型。显式替换 flag **不豁免**坏值拒绝（坏 transcript 事实一律拒绝；flag 形状门先于该检查，两者文案不同）。
- 成功输出在确有继承/替换时携带 advisory 字段 `inheritedOverrides`（`model`/`reasoning` 各带 `value` + `source: "inherited"|"replaced"`；与 effective model 回显同一措辞纪律——展示 WAO 下发了什么，不证明 provider 接受该值）。无覆盖时该字段缺席。
- 想做**无覆盖**重试（回到注册表策略）：不要用 retry——直接 `run` 用原 prompt 重发即可。
- **reuse 形状（诚实口径，R12-C）**：retry 走前台入口，**不解析 sessionReuse 路由**（只有后台派发通道解析）；reuse 形状 agent 的 retry 会以**全新 provider session** 派发（与前台 `run` 同族）——不撞 reuse 互斥门，也不复用旧会话。retry 无 `--require-certified` 入口。

## 认证与当前就绪（历史认证 ≠ 当前可用）

本节合并原 usage §四中与认证/就绪相关的段落：TD-111 认证 advisory 上下文、M11-7 凭据可用性、M12-6 FR-02 provider readiness 真相与语义铁律、`run_dispatch` 的认证定位、TD-131/TD-132 + R23-C 认证门（`--require-certified`）、`lead_preflight` 的认证/授权证明边界。核心边界一句话：**认证是历史可靠性记录，不等于"此刻可启动"**——当前凭据、授权与容量只能由实际 run 的终态事实形成。

**TD-111 certification advisory context**：每个 agent 额外携带两个 advisory 字段——`certificationReasonCode`（闭集机器码，解释"为什么不是 certified"：`case_blocked`（外部 blocker：provider/credential/quota，或显式 blocked）/ `core_checks_failed` / `strict_evidence_failed` / `operational_or_observability_failed` / `missing_certification_checks`，分支优先级与 reliability 认定一致，blocked 优先于 core 失败）与 `certificationLastHealthyAt`（该 worker 最近一次全绿 case 的 bounded ISO-8601 UTC 时间戳，认证新鲜度）。`certificationReasonCode` 在 `certified` 时为 `null`（闭集权威 `certificationReasons.js` 只对 certified 规定原因码为 null，时间字段不受此约束）；`certificationLastHealthyAt` 与 status 投影**相互独立**——无 summary 记录、identity（backend/modelId；TD-131 起在记录与 agent 双侧声明 `providerID` 时同比对；R23-C 起 `providerKey` 同为第 4 比对维——记录侧缺字段 = legacy 容忍，显式 null = 已观察无接入方，判定与 P1-1 派发门共用 `runManager.js` 的 `matchedCertRecord` SSOT）变更后认证不可继承、以及旧格式 summary（缺字段）时为 `null`；`certified` 且存在合法全绿历史时**保留该历史时间**（合法历史时间不因 status 为 certified 而清空）——两字段一律**不伪造**。闭集唯一权威在 `src/application/certificationReasons.js`（MCP schema enum 从它派生，无第二份清单）；worker 级 `reasonCode` 取"决定最终（最差）status 的 case"的码，`lastHealthyRunAt` 聚合 active identity 各 case 的最近全绿时间（旧 identity 的全绿不计入）。两字段只含闭集码/日期——blockerReason 原文、路径、命令、stderr 绝不进任何 wire 输出（磁盘 summary 里的自由文本 `reason` 是另一层契约，保持不变）。

**M11-7 凭据可用性**：`certification` 是历史可靠性认证结果，不等于"此刻可启动"。`credentialAvailability`（`available` / `missing` / `not_required`）只反映 worker **registry 显式声明为必需**的 credential（`provider.apiKeyEnv` / legacy `--api-key-env`）是否在当前环境可用——不声称 runtime 整体健康。优先 `process.env`，回退 Windows Current-User 环境，两处都缺失则为 `missing`；未声明必需凭据的 worker 为 `not_required`。**可选继承变量**（如 `OPENAI_BASE_URL`、`CODEX_HOME`、`KIMI_MODEL_NAME`）会被继承但不参与 missing gate——不会因缺少可选配置阻止派发。`missingCredentialEnvNames` 列出缺失的必需 env 变量**名**（绝不包含值）。`run_dispatch` 在 transcript 写入和 fork 前用同一 readiness 检查拒绝 `missing` 的 worker（零 transcript、零 fork），返回固定可行动错误。WAO 不保存/轮换凭据，不批量导入用户环境，只读取 registry 明确声明的精确变量名；设置或轮换凭据后**无需重启 Host**（每次评估重新观察当前状态）。

**M12-6 FR-02 provider readiness 真相（truth）**：`providerReadiness` 是严格投影对象，字段含义：
- `configurationStatus`（恒为 `"configured"`）——只证明该 registry 条目已配置，**不等于** worker 可运行；
- `authenticationStatus` / `entitlementStatus`（恒为 `"unknown"`）——本次 inventory **没有做任何 provider 探测**，因此**永远不得**宣称已认证/已授权；
- `liveCheckStatus`（恒为 `"not_checked"`）——本次调用**没有做 live check**；
- `credentialAvailability`——同 M11-7 语义，只证明必需凭据 env 名存在（或无需凭据）。

这也意味着 `complete:true`、`certified`、`credentialAvailability:"available"/"not_required"` 与 WAO 控制面工具可用，都**不能**证明当前 provider 仍有 quota 或未触发 rate limit。它们是配置/历史/本地观察事实；实时容量只在实际 run 的终态错误中形成事实。

**语义铁律**：preflight/registry 查询"完成"只表示机械事实（registry 可读、必需凭据 env 名存在/不存在、配置条目存在）可读，**不是** authenticated/entitled/live-checked 的证明。本包不做 provider 网络请求、不读凭据值，所以结构上不可能投影出 `authenticated` / `entitled` / `checked`——MCP schema 的枚举直接派生自这些闭集常量（`src/application/registryInventory.js` 的 `CONFIGURATION_STATUSES` / `AUTHENTICATION_STATUSES` / `ENTITLEMENT_STATUSES` / `LIVE_CHECK_STATUSES`），不存在第二份手工维护列表。真实认证/授权状态只能来自实际运行/诊断（见 `run_diagnose` 的 `code`）。

registry certification 是 **advisory 证据，不是 permission gate**：`registry_list` / `lead_preflight` 把每个 worker 的 `certification` 状态报告给 Lead，MCP dispatch/continuation 以 `requireCertified: false` 调 shared service，**不**强制认证——没有 reliability-summary.json 的 Fresh 克隆同样可派发（lead_preflight 已报告 configured/credential 事实，认证仅作参考）。显式 CLI `--require-certified` 与 RunManager 的 opt-in 认证门保持完整——CLI 或项目治理仍可要求认证。

**行为变更（TD-131/TD-132 认证门收口，2026-08-19，lane 架构前置批次 0）**：显式 CLI `--require-certified` 的 RunManager 认证门自本轮起加两道判定——① **身份比对**：summary 记录的 backend/modelId（`providerID` 在记录与 agent 双侧声明时同比对；记录缺字段 = legacy 容忍）必须与当前 registry 该 agent 的配置一致，不一致按未认证拒绝（固定文案，不回显配置值；判定与 `registry_list` 投影共用 `matchedCertRecord` SSOT——改 `config/agents.json` 换 backend/model 后不重跑 reliability，旧组合的认证不再放行）；② **per-worker 新鲜度**：改读该 worker 自己的 `lastHealthyRunAt`（`npm run reliability` 写入）——缺失/null/不可解析一律 fail-closed 拒绝。旧行为的两个洞：门从不比对身份（旧组合认证照常放行）；新鲜度读整份 summary 的全局 `generatedAt`（重考任一 worker 即刷新全本台账，其余 worker 的陈旧认证被"洗白"，且 `generatedAt` 缺失时旧逻辑竟放行）。行为变化：此前"summary 全局新鲜即放行"的 per-worker 陈旧认证现会被拒，需对目标 worker 重跑 `npm run reliability -- --agent <id>`；`manualOverride:"cleared"` 的 Owner 背书旁路语义不变（仍先于 status/身份/新鲜度放行）。

> **B19 勘误注记（2026-09-26 迁移时按 `src/runManager.js` 现行行为纠正）**：上段 ② 的"缺失/null/不可解析一律 fail-closed 拒绝"是 TD-132 时点表述，未区分三态；现行精确语义见下文 R23-C §2——**仅 `lastFullHealthyRunAt === undefined`（legacy 记录缺该字段）才回落 `lastHealthyRunAt`**，显式 `null`（记录侧无条件写：从未全量绿）与坏时间**不回落**、直接 fail-closed 拒绝。`providerKey` 维度同理三分：记录侧缺字段（undefined）= legacy 跳过该维；显式 `null` = 已观察无接入方，**参与匹配**（与 agent 侧不可派生的 null 相配、与可派生不配）。`manualOverride:"cleared"` 旁路在 summary 中**找到该 worker 记录后**才生效（无记录仍拒），并绕过身份、状态、新鲜度三项检查。

**行为变更（R23-C lane 认证身份维度补全，ADR-0026 v2 方向，2026-08-21）**：认证身份从三元组扩为四元组，新鲜度判据收窄到全量口径，scope 派生对齐文档措辞。三件事：

1. **① 身份第 4 维 `providerKey`（接入方指纹）**：`providerKey = <规范化 baseUrl>|<apiKeyEnv 变量名>`——baseUrl 归一化（scheme/host 小写、去默认端口 `:443`/`:80`、路径保留大小写仅去尾斜杠、丢弃 userinfo/query/fragment 防凭据落盘），apiKeyEnv 只取**变量名**、绝不取密钥值。单一实现 `src/providerFingerprint.js`（reliability 写入侧两处与派发门比对侧同源调用，契约测试钉死逐字节一致）。`npm run reliability` 的 summary worker 记录无条件写入该字段：无 provider 块/不可派生 → 显式 `null`（= 已观察、确认无接入方）；字段缺失（undefined）仅留给 legacy 记录。派发门比对语义：记录侧 undefined = legacy 跳过该维；显式 null 与 agent 侧不可派生（null）匹配、与 agent 侧可派生不匹配；双侧非 null 时逐字节比对——换接入方（baseUrl 或 apiKeyEnv 指向变了）后不重跑 reliability，旧组合的认证不放行。不新增 `provider.id` 之类的注册表 schema 字段。
2. **② 新鲜度改读 `lastFullHealthyRunAt`（全量口径）**：summary worker 记录新增该字段，**仅 full-scope 且全绿的 case 刷新**（取 active-identity 各 case 最大值；delta 全绿是 conditional，不得洗白全量口径的派发新鲜度），记录侧无条件写（`null` = 从未有全量绿）。显式 CLI `--require-certified` 门的新鲜度判定改读它：缺失/null/不可解析一律 fail-closed 拒绝（沿用既有"无新鲜认证/认证已过期"固定文案锚点，过期 reason 只展示天数、不回显磁盘时间戳原文）。**半迁移回落**：legacy summary 缺该字段（undefined）→ 门回落旧判据 `lastHealthyRunAt`（TD-132 行为不变），文案如实标注实际读取的字段名；`manualOverride:"cleared"` 旁路语义不变。MCP dispatch/continuation 不受影响（`requireCertified` 恒为 server-owned `false`）。
3. **③ scope 派生收窄（TD-133(c) 根修）**：`certificationScopeForCase` 不再对 `profile:"delta"` 短路——delta 当且仅当 `profile:"delta"` **且** 该 case 的 drills ⊆ delta 子集；显式 drills 超出子集的行按 **full** 记（与上文"delta 认证规程"的"按实际覆盖派生"措辞对齐）。混合取保守值规则不变。

配套可见性（均非阻塞）：`registry validate` 对已注册但 summary 记录缺 `providerKey` / `lastFullHealthyRunAt` 的 lane 输出 legacy 台账 advisory（半迁移提示，随 validate 既有 ⚠ warning 通道逐行打印/进 `--format json` 的 `warnings[]`，不改 validate 的通过/失败语义）；存量记录**不自动重认证**——补全新维度/新字段的唯一路径是对目标 worker 重跑 `npm run reliability -- --agent <id>`。

（lead_preflight 证明边界，原 §lead_preflight 迁出）M12-6 FR-02：preflight 完成永不意味着任何 worker 已被认证/授权/做过 live check（每个 worker 的 `providerReadiness` 恒为 unknown/not_checked）。

（conditional worker 边界，原 §lead_preflight 迁出）Active run、conditional worker、dirty workspace 只是事实，不自动禁止派发。

