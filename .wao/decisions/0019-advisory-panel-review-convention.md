# 0019: 方案与验收三方会审惯例（advisory，非门禁）

status: accepted
date: 2026-08-15
retains: 0018（WAO 机械围栏定位不变——本惯例是 Lead 纪律，不是控制面行为）
指向: `docs/team-roles.md`（角色与协作权威）、`SKILL.md`（Lead 纪律注入面）
修订: 2026-08-15 首次实战会审（coder_low + auditor 双 PASS）后按两席意见补强：自审/贡献者回避通用化、默认姿态挑明为按需、两席独立性与相反 verdict 仲裁。

## Context

Owner 观察：Lead 单人制订方案、单人验收交付物时，错误发现依赖单一视角。
2026-08-15 四方向评审（coder_mm `run_20260814235928766l1gent` / auditor `run_20260814235936986bt100o`，
全文留档本机 gitignored `.dev/consult/`）与社区研究一致指向：方案阶段与验收阶段各引入
两名评审者（对抗视角 + 异模型家族）能提升缺陷发现率、降低自偏好偏差；
但"强制门禁"与 WAO 治理模型冲突（`playbookCatalog` 冻结契约禁止 advisor/auditor 成为核心角色；
ADR 0018：WAO presents, never decides）。

Owner 裁定（2026-08-15）：以**劝诫级惯例**落地——建议、提醒，不设硬门、不加检查清单义务、
不给 Lead 增加必须证明的流程步骤。同日细化三方组队规则（见 Decision §3）。

## Decision

1. **性质**：Lead 纪律层的劝诫（advisory）。零控制面代码、零 workflow 节点、零 playbook 变更。
   WAO 不因评审缺席阻断任何流程；本惯例不改变任何既有契约。
2. **两个候选时点，默认按需（opt-in）**：
   - 方案制订后、派发实现前；交付物验收前。
   - **默认不审**；出现值得会审的信号时召集——明确未决问题、高风险（触碰安全不变量/跨模块）、
     验证失败后重打包、Lead 低信心等，举例非穷尽。与 `team-roles.md` "顾问/审计按需"原则同姿态，
     不是每个任务默认审的 opt-out。
   - 评审一旦召集，按第 3 条组队；是否召集由 Lead 裁量（第 4 条豁免）。
3. **三方会审组合（Owner 2026-08-15 细化）**：**Lead（拍板）+ 以下两席各取其一**：
   - **实现者视角席**：coder_hq(GLM) 与 coder_low(DeepSeek) 二选一，**避开与被审产出同模型家族**——
     DeepSeek 产出（researcher / coder_low 的方案与交付物）由 coder_hq 审；GLM 产出（coder_hq 的）
     由 coder_low 审；Kimi（coder_mm）与 codex（tester）产出无同族冲突，任选（可按成本取 coder_low）。
   - **对抗视角席**：auditor(Opus) 与 coder_mm(Kimi) 二选一。默认 auditor；coder_mm 用于轮换、
     替补（auditor 不可用 / 成本敏感）。
   - Lead 自己的方案按 Lead runtime 的模型家族套用同族规避（可知时）；Lead runtime 与对抗席候选
     同族时（如 Claude 系 Lead 对 auditor/Opus）优先取另一席。
   - **身份回避优先于家族表（通用规则，2026-08-15 首次实战补强）**：任一席的评审者不得是被审产出
     的作者或共同作者；对抗席亦不得由"前置意见已被采纳进被审方案"的评审者担任（如 auditor 的
     advisory 结论已被写进方案，验收阶段对抗席换 coder_mm）。
   - **规避不可满足时**（候选不可用、混合作者）：Lead 裁量缩小会审（该席缺席）或破例，
     无需审批，建议在会审记录注明破例原因。
   - 注意既有事实：auditor 配置 `sessionReuse: lead_workspace`——同一 provider 会话连审同一任务的
     方案与验收时，方案评审立场会留在会话上下文里侵蚀验收独立性。缓解：两阶段换对抗席评审者，
     或在验收 prompt 里明确要求重述对抗立场。
   - "必有一个参与"指**会审召集时两席各取其一的组队规则**，不是"每个任务必须会审"。
4. **裁量与豁免（本惯例的非强制核心）**：小任务、低风险、Lead 高信心、成本或时延敏感时，
   可以只审一个阶段、缩减会审规模、或整体跳过。**不需要为豁免留痕证明**——评审是工具不是义务。
5. **评审回复形状（建议）**：`VERDICT: PASS/FAIL` + 关键风险（≤3）+ 一个"Lead 没问但应该问的问题"。
   **两席独立性**：两席默认**并行独立**派发、互不看到对方意见（避免锚定复读）；两席 verdict 相反时
   由 Lead 仲裁——采纳任一方、另寻证据或缩小变更，必要时 `wao decision add` 记录。
6. **防走过场（软提醒）**：评审意见与 Lead 最终裁决出现分歧时，建议用 `wao decision add` 或
   handoff 记一条；若连续多次全票通过，Lead 自查是否 rubber stamp。这只是自省提示，
   不设度量、阈值或任何自动判断。
7. **红线（既有契约，重申不变）**：评审意见是证据不是验收；`run_delivery_decide` 只由 Lead 调用；
   WAO 无任何 auto-accept 路径（ADR 0018；仓库规则：无自动 merge/release）。

## Non-goals

- 不做 workflow 引擎"评审门"节点（撞 `playbookCatalog` 冻结契约与 ADR 0018）。
- 不把评审变成必经流水线：`team-roles.md` "不设默认必经审查流水线"继续成立——
  本惯例是按需原则的细化建议，默认姿态不变。
- 不引入评审结果自动流转（N 票通过 ≠ 自动 accept）。
- 不为本惯例新增守卫测试或控制面语义。
