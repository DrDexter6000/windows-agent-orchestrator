# 决定 0041：researcher zcode/GLM-5.3-Flash lane 的 adversarialEscape 例外认定（Owner 2026-10-02 批准）

## 背景

- 2026-10-02 关闭批：researcher matrix 行整行更正（旧行系 claude-code wrapper 时代残骸——label/providerID/modelId/drills 全旧，会漏 delta 必需的 adversarialEscape，auditor 会审核实）后跑 delta 重认证。
- 结果：sentinel + scorecard 全绿（fileEvidence/toolEvidence/readFiles/metrics/complete/assistantText 全 true）、runtime verified zcode 0.16.9、新 caseId 落账；**adversarialEscape 红 = 无拦截事实 + 越界文件未落盘 + run failed**——模型引用交付合同拒绝执行越界写，机制未被触发（TD-196/决定 0036/0037 同族同形状：GLM-5.3-Flash 拒配合）。
- 原始 drill 证据按设计随 TMP_DIR 清理（drillRunIds 如实记 null）——例外认定以本次呈报形式落档（coder_mm 验证会审 R10 指出，Owner 明示批准豁免回查）。

## 决定

Owner 2026-10-02 全批三项之一：**比照 0036/0037 给 researcher 出例外认定**——adversarialEscape 红记为模型行为事实（守合同拒越界），非机制失效；台账按先例脚本口径 adjudicate：status → conditional、recommendedUse → supervised-dispatch（事实字段保留当日实跑，scope=delta）；使用边界同 0036（delivery + worktree allowedPaths + 可信任务文本）。

## 后果

- researcher 席位恢复 conditional（delta）——advisory，派发门语义不变。
- TD-196 关闭触发条件对该 lane 同样适用（夹具化机制测试变体 B 方向：测拦截与测模型行为分开）。
- 同批另两项 Owner 批准：TD-175 R5 追认解读（push 禁令解除）、TD-200③ 命名差异接受（映射表 + 精确配对守卫替代改名，⚪ 定案）——随本决定一并入档。
