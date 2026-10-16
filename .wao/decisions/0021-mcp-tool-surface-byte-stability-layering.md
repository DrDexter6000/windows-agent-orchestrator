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
