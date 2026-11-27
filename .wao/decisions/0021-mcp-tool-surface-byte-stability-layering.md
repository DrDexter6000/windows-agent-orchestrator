# 0021: MCP 工具面字节稳定性分层（追认 M12-16 事实 regime）

日期: 2026-08-16
状态: 已接受（Owner 批准；触发源：2026-08-16 外部审计 P3 + coder_mm/coder_low 双席参考评审）
范围: MCP 工具面（tools/list 呈现层）。CLI 侧冻结承诺（HELP_TEXT、docsSurface、argv 逐字节句）不在本 ADR 范围，维持现状。

## 背景

M12-16 起代码层已运行一套事实上的字节稳定性分层：

- `name` + 注册顺序：live tools/list 与 `toolSurface.js` TOOLS 数组字节等值断言。
- `inputSchema`/`outputSchema`/`annotations` 及一切非 description 字段：M12-16-A description 剥离 SHA-256 冻结契约——任何单字节变动破坏哈希，须显式重冻结并在测试注释记录因果；至今 additive re-baseline ≥8 次（M12-16/17/19/21/22/24/25、TD-111）。
- `description`：M12-16-B 冻结字节天花板治理下可修订；已合法修订多次（M12-16 全文瘦身 -24.9%、M12-19 transport-recovery 锚点恢复）。

问题：`docs/usage.md` §冻结工具面 与 `docs/02-architecture.md` §1 仍承诺五字段"固定且逐字节稳定"——活契约句与代码事实漂移。2026-08-16 一份读完全部权威文档的外部审计把整章建议建立在该句误读上（判"冻结面没有演进策略"），证明该句歧义已在消耗昂贵评审时间。

## 裁定

1. **分层（追认现状）**：
   - `name` 与注册顺序：逐字节冻结。
   - `inputSchema`/`outputSchema`/`annotations`：哈希冻结（M12-16-A）。变更仅限 additive（新增可选字段/闭集成员），须重冻结哈希并在测试注释记录因果；**移除或收窄 = 破坏性变更，须 Owner 批准 + 本 ADR 追加记录（第二档仪式）**——仅当删除的是能力本身时才适用第 4 条 L2。
   - `description`：可修订。约束：(a) M12-16-B 字节天花板不突破（突破须 Owner 批准重基线）；(b) 每次修订附 Lead 复核记录——落点：交付提交信息 + m12-10 注释块因果行（与既有 re-baseline 惯例一致）；(c) 载有规范事实的句子（如 `run_wait` waitMs 范围、transport-recovery 锚点）修订时按 M12-12 趋势优先迁入 schema/semanticNotes，不留在自由文本。
2. **annotations 维持冻结**：宿主将其用于权限/自动批准 UI（readOnlyHint/destructiveHint），修订有行为后果。2026-08-16 双席参考评审一致意见：不随 description 一起放开。
3. **additive-first**：演进优先加法；新工具走 roadmap 治理门（第 23 工具触发条件不变）。
4. **减面两级**：
   - L1 降级：工具移出工具面、能力改由 MCP resources 承载（先例：playbook 工具 23→21，M12-10）。不违反"没有任何能力被永久移除或弱化"句；Lead 裁定 + ADR 记录（授权来源：本 ADR 经 Owner 接受；与 roadmap:108 扩面门对称——扩面走 Owner 门，L1 减面走 Lead+ADR）。
   - L2 真删除：删除能力本身。须 Owner 明示 + 修订 `02-architecture.md`"没有任何能力被永久移除或弱化"句 + 本 ADR 追加记录。
5. **活契约句修订**：usage.md / 02-architecture.md 五字段句改为分层表述；docs-consistency 增反回归守卫禁止旧句复现（TD-119 模式）+ 新分层句正向锚。

## 影响

零运行时行为变更；零 wire 字节变更（纯治理文档）。m12-10 哈希/天花板常量不变，其注释块补一行指向本 ADR。

## 附录 A：非冻结区清单（三档）

| 档 | 覆盖 | 仪式 |
|---|---|---|
| 重冻结 | schema/哈希域任何字节（additive）、description 文本（天花板内） | 重冻结哈希或天花板按达成值 + 测试注释因果 + description 另附 Lead 复核记录（提交信息 + 注释行） |
| ADR | 工具面增减（含 L1 降级）、分层边界变化、天花板重基线、schema 字段移除/收窄 | 新 ADR 或本 ADR 追加 + Owner 批准 |
| Owner 明示 | L2 真删除、定位类叙事（PRD/roadmap 定位节） | Owner 批准 + 修订对应权威句 |

## 评审记录

2026-08-16 计划双席均 CONDITIONS 后由 Lead 裁定并入：coder_mm（run_20260816001540792duokqa）P0-1/P1-1~5；coder_low（run_20260816001550852vhncp5）P0-1~3/P1-1~10（其中 readiness×candidateKind 配对由 Lead 亲读 runDelivery.js 证实后采纳）。两条显式拒绝见 Round 3 计划 §7。

## 追加记录：2026-09-18 schema 收窄（TD-153 批B 两项，Owner 指令批准）

- run_status 的 scorecardSummary.failedChecks：z.array(z.string()) → z.array(z.enum([...SCORECARD_CHECK_NAMES])).max(SCORECARD_CHECK_NAMES.length)（闭集 6 成员；非成员/超限崩为 fixed safe text，不截断）。
- 依据：Owner 2026-09-18 指令（上限值按双席建议定档）+ 双席咨询 run_202609180757006603nxdsx / run_20260918075704956eh790g。
- 手续执行：FROZEN_22_WIRE_CEILING 78014→78127 与 DESC_STRIPPED_CONTRACT_SHA 均重测重冻（m12-10 注释链 truthful 记录）；FROZEN_22_DESC_CEILING 未动（零 description 变更）。

## 追加记录：2026-10-15 schema 收窄（会动工作区的工具必传目标，Owner 批准）

- 事实背景：同一宿主进程挂一个 MCP 服务实例、多个宿主会话共用时，会话级 workspace 选择互相串扰——未选过项目的会话读到别人的 `lead_session` 绑定，派发随之进错项目。修法（本 ADR 范畴内的收窄部分）：会动工作区的九个调用（`run_dispatch`、`run_continue`、`run_correct`、`run_stop`、`run_collect`、`run_delivery_decide`、`run_delivery_reverify`、`run_delivery_repackage`、`run_consult` create）的目标只取本次调用的 `expectedWorkspaceRoot`。
- schema 面：八个 runId 工具与 `run_consult` 的 inputSchema 各增**可选** `expectedWorkspaceRoot` 字段（additive）；`run_dispatch` 的同名字段由"可选断言"改为 handler 内必传（固定文案拒绝，缺参零副作用）——schema 保持 optional 是因为 `RUN_DISPATCH_INPUT` 与 `run_dispatch_contract_check` 共享，schema 级必填会连带后者；后者现在自己消费该字段（给了就按它检查并在出参 `workspaceScope` 写明范围），`run_consult` 的读取/分页模式同样接受该字段（给了就按它定位组记录）。原不带目标的合法调用自此被拒：各宿主 Lead 的首次 A 类调用会被拒一次，文案指明该传什么，补参重试即恢复（`SKILL.md`/`docs/usage/host.md` 同批更新）。其余 additive 成员：`workspaceProof.source` 闭集增 `call_target`（证明来源如实标注）；`lead_preflight` workspace 增 `projectBucket`、`runs_list` 增 `scope`（只读结果的范围可见性）；`run_dispatch_contract_check` 出参增 `workspaceScope`。
- 依据：Owner 2026-10-15 批准（Lead 两项请批——"会动工作区的工具必须写明目标项目、不写就拒；MCP 工具描述的字节冻结线随之重冻"，Owner 答复"我同意两件都批"）。
- 手续执行：FROZEN_23_WIRE_CEILING 85101→88048、FROZEN_23_DESC_CEILING 10125→11783（描述各加一句必传目标说明与范围可见性说明；Owner 硬顶 12347 内）、FROZEN_23_HOSTVISIBLE_CEILING 20699→22941，DESC_STRIPPED_CONTRACT_SHA 重测重冻（m12-10 注释链如实记录）。同批会审修复再动描述与 schema（consult 读取目标、contract_check 范围、run_stop 描述）后按实测重冻到上述值。

## 追加记录：2026-11-19 减面 23 → 20（第 119 批，决定 0125）

- **L2**：删除共享项目选择（`workspace_select` 与 `lead_session` 绑定来源）。
  - Owner 明示（2026-11-19："收掉两个多余的工具 —— 不要等，该做就做"）。
  - `02-architecture.md` 冻结工具面一节"没有任何能力被永久移除或弱化"句，已按本档修订为列出能力承接点。
- **L1**：`workspace_status`、MCP `run_wait` 撤出工具面。承接点是现有工具（`lead_preflight.workspace`；`run_await_result` 到终态、`run_delivery` 带 `waitMs` 到交付收口、CLI `runs wait --until-settled`），不是 MCP resources。第 4 条 L1 的"能力改由 MCP resources 承载"据此修订为"能力改由现有工具或 MCP resources 承接"。
- **schema**：
  - `lead_preflight`：
    - 输入 `workspaceRoot` 改名为 `expectedWorkspaceRoot`（移除加新增，属破坏性）；
    - 删除 `workspaceSelection`；
    - `source` 闭集删 `lead_session`、增 `call_target`；
    - `workspace` 节增 `workspaceRoot`；
    - annotations 的 `readOnlyHint` 改为 true。第 2 条说宿主据 annotations 自动批准；改 true 是因为这个工具已不再写任何状态。
  - `run_status`/`run_diagnose` 增可选 `expectedWorkspaceRoot`（additive）。
- **手续执行**：
  - 三条天花板按实测下调：`FROZEN_20_WIRE_CEILING` 93849→87149，`FROZEN_20_DESC_CEILING` 12219→11291，`FROZEN_20_HOSTVISIBLE_CEILING` 23937→22436；
  - `DESC_STRIPPED_CONTRACT_SHA` 重测重冻；
  - m12-10 注释链如实记录。

## 追加记录：2026-11-23 减面 20 → 17（第 134 批，决定 0129；会审修正后改写）

- **L2（能力并进后的真删除）**：`registry_list`、`runs_list`、`run_delivery_review_bundle` 三个只读工具删除；能力承接点分别是 `lead_preflight`（workers 用回 `AGENT_ENTRY` 同一 schema 且不设上限 + `detail`/`recentRuns` 可选输入）、`run_delivery` + `run_delivery_review` 两步（Lead 自行对照 `deliveryCommit`/`changedFileCount`，无跨结果保证）。**`run_dispatch_contract_check` 保留，不删**——首轮交付把它并进 `run_dispatch` 的就地预检，交付会审（sol）核出"只预检不派发"与 `availableProfiles` 在 MCP 面没有等价物，Lead 裁定恢复（见 0129 改写后的正文与"不采纳"一节）。Owner 批准删除只读工具的原话以"能力不丢"为前提（2026-11-22："4 个只读 MCP 工具有等价物，可以下沉——能力不丢的前提条件下，同意删"）；对本工具该前提不成立，故保留。
- **schema**：
  - `lead_preflight`：输入增可选 `detail`（闭集）与 `recentRuns`（对象 `{limit?:1..100, activeOnly?:boolean}`；limit 缺省 50，与原 `runs_list` 一致，activeOnly 先筛活动再截断）；`workers` 条目改用 `AGENT_ENTRY` 同一对象（+`cwd`/`sessionReuse`/`missingCredentialEnvNames`/`dispatchHold`），数组**不设 max**（原 `registry_list` 无上限，会审修正删掉 `WORKERS_CAP=64`）；输出增可选 `certificationEvidence` 与可选 `recentRuns` 节（条目同原 `runs_list.runs[]`；请求了但读不出/未绑定为 `null`，未请求键缺席）。
  - `run_dispatch`：输出增可选 `contractAdvisories`（闭集码 + 有界说明，上限派生自 `CONTRACT_CHECK_ADVISORY_CODES` SSOT）；提醒数组在派发前严格预校验，畸形/超限整组丢弃。
  - 三个被删工具的 inputSchema/outputSchema/annotations 整体离开 stripped 载荷；`run_dispatch_contract_check` 的 schema 保留在载荷内。
- **手续执行**：
  - 三条天花板按实测下调重冻：`FROZEN_17_WIRE_CEILING` 87157→76543，`FROZEN_17_DESC_CEILING` 11291→10402，`FROZEN_17_HOSTVISIBLE_CEILING` 22436→20870（均仍低于 2a1875ac 的冻结值：只降不升）；
  - `DESC_STRIPPED_CONTRACT_SHA` 重测重冻为 `d398828b8eef5da845ed66f579ab4906860303b3a7989556e8c2644ac70625b8`；
  - m12-10 注释链如实记录。

## 追加记录：2026-11-23 schema 收窄 + 缺省化（第 135 批，决定 0130；Owner 2026-11-22 同意执行头脑风暴结论）

- **收窄**：八个写类工具（`run_dispatch`、`run_continue`、`run_correct`、`run_stop`、`run_collect`、`run_delivery_decide`、`run_delivery_reverify`、`run_delivery_repackage`）的 inputSchema 把 `expectedWorkspaceRoot` 从 optional 改为 required（2026-10-15 追加记录里"handler 内必传、schema optional"的状态收口——schema 标必填后模型看 schema 即知，缺参在 wire 校验即被拒；处理器固定文案保留为兜底）。`run_dispatch` 与 `run_dispatch_contract_check` 共享输入对象，从共享基础对象派生 run_dispatch 严格版，不复制整份；contract_check 与 `run_consult` 的读取/分页模式、其余只读工具保持 optional。
- **缺省化**：`DELIVERY_INPUT.mode`（`z.literal("git_commit_v1")` → optional literal；缺省值在 `prepareDeliveryRequest` SSOT 落地）与 `run_continue` 的顶层 `delivery`（省略即继承父运行已生效的合同，决定 0130）改为可省——required 数组删 `mode`/`delivery`，属性形状不变。
- **手续执行**：三条天花板按实测重冻，均不高于 main 的冻结值（76543/10402/20870）：首交付 76543→76532/10402→10231/20870→20859；续修（两席会审后 Lead 裁定）出参增可选 guidance（+45B schema）、恢复 cursor=nextCursor 与 "(any worker event)" 两句描述、同批压 reverify/repackage/stop/continue 的重复措辞，终值 76543→76535、10402→10189、20870→20817；`DESC_STRIPPED_CONTRACT_SHA` 随 schema 如实翻新为 `e3de9cbb1ba6720b0d6e750b267d841727fcbbafa31749c4aecc1f75ea8e7295`（首交付值 82b48f5b…）；m12-10 注释链如实记录。

## 追加记录：2026-11-26 `run_dispatch.taskType` 与 `run_diagnose.isolationViolation`（第 141 批，决定 0131；Owner 2026-11-24 同意为 `taskType` 合理抬高上限）

- **schema**：`run_dispatch` 输入增可选 `taskType`（`z.enum(["image"])`），`run_dispatch_contract_check` 的输入面不变；`run_diagnose` 输出增可选严格对象 `isolationViolation`（`reason`/`destination` 为 enum，三个路径字段 `maxLength` 300），只在 `workdir_escape` 且事件绑定本 runId 时出现；`run_activity` 的信封标签闭集增 `isolation_violation`。
- **手续执行**：三条天花板按实测重冻为改动后的实测值：wire 76535→77446，描述 10189→10296，hostVisible 20817→20970（改动前 HEAD 实测 76529/10183/20811，旧线各有 6 字节余量未沿用），离 Owner 硬顶 94532 余 17086；`DESC_STRIPPED_CONTRACT_SHA` 重冻为 `e2db4509d342a49eb33866c19b134ba0af5c411cc48b268e7c927bb7f222927a`；`npm run gen:surface` 只改 `docs/surface/mcp-tools.md`。
- **第 152 批（车道高峰结构化，2026-11-26）**：`lead_preflight` 出参 `lanes` 每行增可选严格对象 `peakNow`（`state` 为 enum `peak|off_peak`、`until`、`untilLocal`），顶层增 `now`（`beijing` 标签、`holidaysRecognized` 恒 false）；描述与 inputSchema 不变。wire 天花板按实测重冻 77446→77985（离 Owner 硬顶 94532 余 16547）；`DESC_STRIPPED_CONTRACT_SHA` 翻新为 `0ecb54632165e40712ef4f9c8c4c21b2f92cd97f7ff00b0a2a893dabaaca0723`。
- **第 153 批（额度池结构化，2026-11-26）**：`lead_preflight` 出参 `lanes` 每行增 `quotaPool`（字符串 1–40 或 null，上限与画像校验同一常量 `QUOTA_POOL_MAX_CHARS`）；描述与 inputSchema 不变。wire 天花板按实测重冻 77985→78084（离 Owner 硬顶 94532 余 16448）；`DESC_STRIPPED_CONTRACT_SHA` 翻新为 `9517c289518d2fb44e93a98855d8e59f72a5b2638a1edd58c8f903a097d0d496`。
- **第 154 批（默认可续修，2026-11-27，决定 0133）**：`run_dispatch` 出参增必填 `continuable`（布尔）与可选 `continuableOff`（enum `no_workspace|override|backend_unsupported|session_reuse_unavailable|argv_budget|lineage_slot_unavailable`）；描述 10296→10295，inputSchema 不变。wire 天花板按实测重冻 78084→78291（离 Owner 硬顶 94532 余 16241）；`DESC_STRIPPED_CONTRACT_SHA` 翻新为 `f8995a0657fe7b1903ea23d270bc95cb222e32fd8f20c58c6bdf22e6dc183592`。
- **第 155 批（会审轮次与审查口径，2026-11-27）**：`run_consult` 输入增可选 `follows`，出参增 `round`/`roundAdvisory`；描述 10295→10334。三条天花板按实测重冻：wire 78291→78507、描述 10296→10334、hostVisible 20970→21103（离 Owner 硬顶 94532/12347 余 16025/2013）；`DESC_STRIPPED_CONTRACT_SHA` 翻新为 `0128ed7d9e8c6db524c4d64a963f3c021532684999ac4e3e92d66fbc57de4c67`。
