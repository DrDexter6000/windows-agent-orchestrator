# 0027: 第三方审计处置（Owner 四条裁定 + 审计七条逐条裁定）
status: accepted
date: 2026-08-22

## Context

第三方顾问对本仓做了战略+技术两层独立审计（2026-08-22）。Lead 对其 17 项定量/事实声称逐项核实并给出看法；随后 Owner 指定双席独立评审：coder_mm run_20260822171509915i8y3yc、auditor run_20260822171509567sz4zsv，两者 verdict 均为"各打五十大板"。

双席制度本轮两次实证价值：
1. **auditor 纠正了 Lead 的一处误判**：审计称"239 个测试文件"，Lead 按 `*.test.js` 口径（228）判其为错。auditor 以 `test/` 全树口径复核为恰好 239（228 个 `.test.js` + 11 个辅助文件：manifest/reporter/helpers/fixtures），审计无错，Lead 判定撤回。
2. **auditor 发现一处真实护栏漂移**：`docs/usage.md` 把 manifest 类别写成 6 个（漏 `mcp`），与 `scripts/canonical-test.mjs` MANIFEST_GROUPS(7) 及 `AGENT_ONBOARDING.md` 不一致——TD-72 所述漂移发生在有 docs-consistency 护栏的文档内，证明护栏是白名单、存在覆盖面问题。

Owner 2026-08-22 四条裁定（要点）：
1. 治理称重可做，但**绝对不要轻易砍流程**——部分流程系 Owner 作为人类刻意为之；
2. Node 日历线同意，但更好方案是**定期检查 Node v24 的 bug 何时被修复**，修复后即可用 v24；
3. 护栏体检同意，但**不要过度工程，够用就好**；
4. 其余同意 Lead+双席收敛意见。

## Decision

1. **治理称重立项**（首期基线 `docs/research/governance-cost-baseline-2026-08.md`）。硬约束（Owner）：测量 ≠ 裁剪授权；基线只提供事实，任何砍流程动作须 Owner 另行裁定。
2. **Node 版本线登记 TD-140**。主路径按 Owner 修改：定期检查 Node v24 libuv Job Object 回归是否修复，官方修复版发布即评估升级 v24（升级机制已备：`src/nodeVersionGuard.js` BLOCKED_RANGES / ALLOWED_FIXED_VERSIONS + engines）；辅路径：2027-01 若无修复迹象再评估迁移目标。伴随项：认证可移植性评估。
3. **护栏体检立项 TD-141**，约束=不过度工程、够用就好：一次性"现有机器护栏 vs 文档化不变量"对照清单，不建新框架；首个实证 usage.md mcp 本批修复。
4. **workflow 层不动**（TD-142）：929 行 ≈ src 1.8%，wf_ 643 次 ≈21% 且 8 月聚簇走低；降级流程开销 > 年维护开销（auditor 论证采纳），记观察项。
5. **风险观察两条登记 TD-143**：(a) transcript 可访问性依赖——证据链层原材料来自 runtime 厂商 transcript，厂商收紧即间接扼杀第三方审计层；(b) N=1 方法论连续性——整套实践无第二读者/操作者。

### 审计七条逐条裁定（补 coder_mm 指出的程序缺口）

| # | 审计建议 | 裁定 |
|---|---|---|
| 1 | 战略定位 = 个人基础设施 + 方法论试验场，非产品 | 接受（与 PRD §2 N=1 声明一致，无新行动） |
| 2 | 预设"吸收地平线"退出条件 | 接受并登记于本决策：触发 = host 原生多 agent + 跨 provider 路由覆盖 Lead 闭环约 80%；触发后 dispatch 层转维护模式、资源转向证据链层 |
| 3 | 把证据链层当作唯一可能外化的资产培育 | 方向接受、立项暂缓：未来立项须 Owner 批准；首日交付物必须是规范 + 冻结 conformance 测试而非纯文档（TD-72 自指应用，coder_mm 提出） |
| 4 | 给 Node 22 EOL 登记带日期触发条件 | 接受（Owner 修改为 v24 修复观察主路径）→ TD-140 |
| 5 | 给治理称重 | 接受（Owner 硬约束见上）→ 基线 v1 已出 |
| 6 | 先做 3 分钟 demo 视频再谈外部用户 | 缓办：外部用户目标激活前不为外部用户做任何功能；激活时视频先行、再测陌生人 time-to-first-canary |
| 7 | 继续不做清单（自动纠错循环/语义路由/GUI/POSIX lane） | 维持既有裁定不变 |

## Consequences

- `docs/tech-debt.md` 新增 TD-140..143；`docs/usage.md` 单点修复（补 mcp 类别）。
- 治理成本基线为观察工具非考核工具；v1 为近似口径（席位计数 + 样本闭环实测），自动化聚合待真实需要再立项。
- 双席方法论产出沉淀为两条原则：外化必带冻结测试；护栏需要覆盖率视角（不仅白名单存在性）。
