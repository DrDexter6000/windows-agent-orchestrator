# ADR-0032 §8 五态落地：在册认证记录影响评估（2026-09-21）

status: 过程/调研快照（一次性评估，不随代码演化改写）
scope: 评估对象 = 2026-09-21 时点外层主仓 `runs/reliability-summary.json`（组合层，
9 个 worker 记录）与 `runs/component-checks.json`（组件层，1 条 deepseek-acp 记录）。
本批改动 = ADR-0032 §8 五态 + 声明闭集双向一致性 + reportsCommandExitCode 诚实声明
+ 运行时身份入账。**不许静默改严，也不许因为怕影响记录就不改**——本文逐处说清
每条改动可能让哪些既有记录在下次运行时失效/变形，为什么。

## 总原则（为什么多数改动"看起来吓人但记录不红"）

1. 组件层**不进任何派发门禁**（ADR-0032 Consequences）；组合层的
   `workers[].capabilities` 映射经查**无 src/ 消费方**（`grep -rn "\.capabilities" src/`
   零命中；wire 投影 `registry_list`/`buildCertMap` 只读 status/recommendedUse 等
   白名单字段）——能力绿的消失是**可见性变化**，不是门禁变化。
2. N/A 的语义是"不算失败"：除下文 C6（dsh 的 commandsPassed，**放宽**）外，
   五态化对组合层 status 的净效应是**不变或更严**，且更严的方向都是"原本就在
   造假绿"的面。

## 逐处改动 × 既有记录影响

### C1 `metricsNonZeroCheck` 不适用改记 N/A（原 `pass:true, capability:"metrics"`）

- **coder_mm（kimi-code，certified，lastFullHealthyRunAt 2026-08-20）**：
  下次 reliability 运行——status **不变**（observability 类目由 N/A 覆盖，TD-87
  症状解除保留）；`capabilities.metrics` **true → 消失**（N/A 不贡献能力绿）。
  为什么可接受：该绿本来就是伪造的（kimi stream-json 无 usage，检查从未真正
  断言过什么）；能力缺口事实继续由 backend 声明 + `registry validate` ⚠ 承载。
- **deepseek_acp_deltadrill（deepseek-acp，draft-only）**：metricsNonZero 原即
  "not applicable"文案的 pass；改 N/A 后同样不算失败，`capabilities.metrics`
  消失。status 不受影响（draft-only 来自 strict 失败，见 C6）。
- **不受影响**：coder_hq / researcher / coder_low / tester / auditor / coder_hq_deltadrill
  （claude-code、codex 声明 reportsTokenUsage=true，断言分支形状不变）；
  kimi_opencode_test（opencode-serve 声明 true，同上）。

### C2 `silentTimeout` serve 不可达时记 N/A（原"skip 顶绿"）

- 影响面 = **suite 级 case**（caseId `silentTimeout`，无 agentId，不进 worker 聚合）。
  下次无 serve 的运行：该 case 的 certification **certified → conditional**
  （零正向证据守卫：全 N/A 不得 certified）；`pass:false` → `lastHealthyRunAt:null`。
  **退出码不变**（allPass 只受真失败影响——serve 不可达不是失败）。无任何 worker
  记录受影响。

### C3 `hasSentinel` 收严为 assistant 回显（原搜所有 message）

- 影响面 = **全部带 sentinel drill 的 lane**（9 个 worker 记录全带 sentinelA/B 绿）。
  若既有绿是 assistant 回显承载（drill 设计如此：任务要求模型在 JSON 回答里回显
  文件内容）→ 下次运行**不变**；若某记录的绿只来自 tool_result/用户消息里的
  sentinel 子串 → 下次运行 sentinelA/B 红 → core 失败 → **rejected**。
  静态无法逐一核验（需逐 transcript 检查 assistant 文本）——**列为残余风险**，
  以下次真实运行为准。不改回去的理由：读文件 ≠ 回显，回包外搜到不构成模型
  消费了该值的证据（ADR-0032 §8 点名坏模式）。

### C4 `runStrictScorecardDrill` 文件证据升级为存在 + 内容承载 sentinel（原只查存在）

- 影响面 = 全部带 scorecard drill 的 lane（coder_hq、coder_mm、researcher、
  coder_low、tester、auditor、coder_hq_deltadrill、deepseek_acp_deltadrill 的
  `fileMaterialized:true`）。模型被明确指示"文件内容 exactly: FILE_…"——内容
  匹配是常态；若历史上有"文件存在但内容不是 sentinel"的假绿 → 下次运行红
  （strict 失败 → draft-only）。**残余风险**：同 C3，需下次运行确认。

### C5 `scorecardChecksFromResult` 缺 scorecard 记红（原用 completed 顶替）

- 既有 9 条记录的 case 都带真实 scorecard checks（含 dsh 的
  hasDoneEvent/commandsPassed/filesExist）→ **无现存记录依赖该 fallback**。
  未来任何"run 完成但 scorecard 检查缺失"的 lane 将红（strict → draft-only）——
  这是修掉假绿的预期效果。

### C6 `commandsPassed` 按 `reportsCommandExitCode` 条件化（证据不可取得时 N/A）

- **deepseek_acp_deltadrill（deepseek-acp，draft-only）**：下次 delta 运行在
  `exitCode=undefined` 这种证据不可取得形状下，`commandsPassed` 从红变为 **N/A**，
  `capabilities.commandEvidence` false → 消失；N/A 不进入 `failedChecks`，因此不把
  能力缺失伪造成质量失败。组合资格另有守卫：必需 strict 轴为 N/A 时仍保持
  **draft-only**，不会由 backend 布尔声明间接升级到可派发集合。若 scorecard 已
  明确观察到非零退出，则保留真实 fail，声明不得遮蔽。
- 其余 backend 全部声明 true → 无变化。

### C7 certifyCase 零正向证据守卫 / C8 检查级 blocked 映射

- 现存记录全部有 pass 检查、无检查级 blocked 生产者 → **零记录影响**。守卫只
  封"全 N/A 拿 certified"的假绿面（现实中只有 C2 的 suite case 会走到）。

### C9 `supportsSessionReuse=true` 判据升级为真实跨 run 恢复证据（组件层）

- **backend:deepseek-acp@da12bfa…（component-checks.json 唯一在册记录，pass，
  2026-09-20 验证时 declared=false）**：代码现已声明 true。下次 component-check：
  判据 = Phase 6 真恢复证据（`scripts/reliability/dsh-acp/evidence/phase6-session-reuse.json`
  在册且校验通过：同 session 跨两 run + resume 路由 + marker 复述 + 3/3 负对照
  拒绝）→ **该轴保持绿**。
- **claude-code（声明 true，无在册组件记录）**：下次 component-check 该轴将
  **红**（"declared=true 但无真恢复证据在案"）——直到跑一次 Phase-6 形式的
  恢复 drill 并把证据登记进 `SESSION_REUSE_EVIDENCE_SOURCES`。这是有意的诚实
  收紧：声明支持就必须有正向证据，session 锚点（只证明会话建立）不再顶替。
- **codex / kimi-code（声明 false）**：走“不支持时必须明确拒绝”的负向探针，
  不会因缺真恢复证据进入上述红分支。
- **deepseek-harness / opencode-serve（声明 false）**：fail-closed 拒绝探针方向
  不变，无影响。
- 组件台账独立，`runManager` 不读取它，因此上述组件层收紧**不连带撤销现有组合认证**。

### C10 声明闭集扩到六轴（组件层新增 roleContract / exitCode 判定 + 两个 N/A 轴）

- 六个 backend 都声明 supportsRoleContract=true → 下次 component-check 新增一次
  真实派发的角色合同回显探针（systemPrompt 变体 + 合同内 marker）：合同通道若
  破损即红——**新的失败面**（此前从未实测过合同送达）。reportsCommandExitCode：
  dsh 记 N/A；其余五 backend 需探针 run 的 scorecard commandsPassed 绿（探针里
  模型须真跑 `node --version`）。supportsInFlightCorrection / replayByRespawn 记
  N/A + 原因（无组件层机械探针面——MCP-only 面 / 无配置面）。
- 在册 deepseek-acp 组件记录是历史事实，不被改写；下次运行按新轴重判。

### C11 组件层五态判定（`componentResultFromChecks`）

- 全 N/A（零正向证据）→ fail：现存记录无此形状 → 零影响。

### C12 运行时身份入账（组件键升级 + runtime-drifted advisory）

- 下次 component-check 写**新键** `backend:<name>@<codeRef>#<fingerprint>`。在册
  legacy 记录 `backend:deepseek-acp@da12bfa…`：其 codeRef ≠ 下次运行的 HEAD →
  按既有 codeRef-滚动语义被键级修剪（非本批新行为）；若在同 codeRef 上重跑，则
  该记录（无指纹，无法证明同运行时）降 **runtime-drifted advisory 并保留**。
- **opencode-serve**：HTTP 服务无本地二进制 → 身份明确记 `verified:false`，并按
  backend 探测目标生成稳定 `unverified-v1-*` 指纹。同一未验证目标不再每次产生
  新键；稳定键只用于消除重复噪声，绝不表示 serve 部署身份已经验证。

## 结论

- **组合层**：9 条在册 worker 记录中，coder_mm 的伪造 metrics 能力绿消失但认证
  结论不变；deepseek_acp_deltadrill 的 commandEvidence 诚实缺席，同时因必需 strict
  轴为 N/A 保持 `draft-only`，不自动放宽到 conditional。C3/C4 是需要下次运行确认
  的收紧面（预期常态绿，异常才红）；其余不动。
- **组件层**：在册 deepseek-acp 记录在新判据下仍绿（Phase 6 证据在案）；只有
  同样声明 `supportsSessionReuse=true` 的 claude-code 会因真恢复证据缺口如实红。
  codex / kimi-code 声明 false，继续走负向拒绝探针，不受该正向证据要求影响。
  补 claude-code 证据是后续工作，不是本批缺陷。
- 所有"变红/变形"方向都是 ADR-0032 §8 点名的坏模式修正；没有为保记录而保留
  任何假绿路径。
