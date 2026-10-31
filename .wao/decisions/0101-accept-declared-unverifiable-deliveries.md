# 0101 派发时声明"无可跑验证"的交付，Lead 审查后可以接受

- 日期：2026-10-31
- 状态：accepted
- 来源：
  - 宿主项目反馈 fb_20261030T195830Z_7j7166（2026-10-30）：一次文档整理类交付按派发合同只写了 `verificationUnavailableReason`。worker 正常完成，Lead 审过内容、已手工采纳，`run_delivery_decide accepted` 却被拒为 `verification_failed`。记 reject 会给车道记一笔不实的否决；不记，工作树一直留在 `.wao-worktrees\`。
  - Owner 2026-10-31：先问 kimi 与 sol 的意见，"你汇总意见并做取舍后直接执行，我批准"。
- 关系：修订 accept 门（原规则：accept 要求 effective verification 为 passed）。不改 reverify、repackage 的资格，不改 MCP 工具面。
- 方案会审：kimi、sol 均判 PASS_WITH_NOTES（consult_2026103104260577861f3it），两席各自给出了第 1 条的收窄。
- 合入授权：Owner 2026-10-12——"只要是你联合会审过的，我都许可 commit & push"；本条另有 2026-10-31 的批准。

## 背景

- 派发合同里 `verificationCommands` 与 `verificationUnavailableReason` 二选一。写后者时验证器不跑命令，原始验证结果为 `unavailable`。生产路径上，原始 `unavailable` 只有这一个来源。
- 写门（`tryAppendDecision`）、恢复资格（`recoveryAcceptable`）和读面对已有决定的校验（`_validateBoundDecisionEvent`）都要求 accept 由 passed 背书，所以这种交付只能 reject 或一直挂着。本机全部转录里，原始 unavailable 的交付只出现过 2 次，宿主那次第一次用就撞上了。
- 对这种交付，这道门什么也挡不住：一条什么都不验证的命令（如 `node -e 0`）就能让交付 passed，再 accept。它真正有价值的部分是：Lead 声明了检查，而检查失败、没跑完或出错时，不能直接记 accepted。这部分保留。

## 决定

1. **"声明无可跑验证"由一个纯谓词判定**，放在 `src/transcript.js`，写门、恢复资格、已有决定的校验共用。三条同时成立：
   - created ref 的 `verification.commands` 是空数组（缺失或非数组都不算），`unavailableReason` 是去掉首尾空白后仍非空的字符串。声明只看 created ref，结果事件或决定快照上补出的理由不算；
   - 恰有一条绑定的原始结果事件，类型是 `run.delivery_verification_unavailable`（以类型为准；内嵌状态缺失或仍写 pending 的旧形状照现有兼容规则读）；
   - 转录里没有任何 reverify 事实：任何信封里、类型以 `run.delivery_reverification_` 开头的事件都算，含畸形与孤立的。这个判断就是收口判定已经在用的 `hasReverifyFact`，它搬进 `src/transcript.js`，`src/application/runSettlement.js` 从那里导入并照旧导出。
2. **写门**：accept 在原有的 effective passed 之外，也接受满足第 1 条的交付，正常 completed 路径与恢复路径同一规则。恢复路径照旧须有有效的重打包来源；它原本只认原始验证 passed，这里只加第 1 条这一支，不改成 effective。
3. **读面**：已有的 accepted 若快照声明 unavailable，须满足第 1 条，且由决定之前那条绑定的原始 unavailable 事件背书；其余组合照旧无效。
4. **不加输入字段、事件或工具**：决定理由本来就必填，记进决定事件；决定事件内嵌的 ref 保留 `verification.status: "unavailable"`，事后可区分。这种 accept 的其余后果（线系不可续接、上游会话释放、回收分类）与 passed 的 accept 相同。
5. **不变**：failed 仍须一条完整的 reverify 链 passed 才能 accept，恢复路径照旧不认 reverify；pending 永不 accept；unavailable 仍不能申请 reverify；MCP 的输入、输出和 `rejectionReason` 闭集不变。

## 否决的备选

- **只在派发时提示"这种交付以后无法 accept"**：这个模式照样只能以 reject 收场。
- **取消 `verificationUnavailableReason`，强制至少一条命令**：逼出形式主义的命令，不增加任何保证。
- **以"已手工采纳"结案**（决定 0098 的采纳读数）：采纳读数按设计只读、不结案，改成结案事实，改动面大得多。
- **accept 时另加显式确认参数**：理由已必填；再加参数要改 MCP 工具面和冻结线，只多一道手续。
- **泛化成"effective verification 为 unavailable 即可 accept"**：会让"原始 failed、reverify 结果 unavailable"的交付被接受。

## 已知边界

- WAO 不验证这种交付；接受完全取决于 Lead 的审查和理由。
- 原始结果的追加器照收传入的结果，事实校验器也不单独核对 unavailable 结果的声明形状，所以谓词自己核对 created ref 的声明。手工伪造的转录不在防护范围内，与现有事实校验一致。
- 宿主那次已经手工采纳的运行，要由宿主的 Lead 自己记 accept；WAO 不替它补记。
