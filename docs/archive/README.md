# 档案门户 — 全部历史档案的入口

> ⏳ **本文件是全部过程类与历史档案的入口，不是现行契约源。**所覆盖的档案是冻结的历史快照。
> 当前契约见 [`../02-architecture.md`](../02-architecture.md)（架构/状态机）与 [`../tech-debt.md`](../tech-debt.md)（技术债）。
> 档案文件**只追加、不回写事实**（`../ssot.md` §2「过程文档只追加」）。

## 本目录内容（冻结快照）

| 文件 | 性质 | 冻结原因 |
|------|------|---------|
| `m0~m7-audit.md` | 里程碑审计快照 | 记录 M0–M7 各阶段的动态（新登记/偿还的 TD）+ 当时的测试数。决策已收敛进契约，本文不再维护事实 |
| `docs-ssot-audit.md` | 2026-06-16 SSOT 审计 | 历史审计报告，结论已被 `../ssot.md`（文档分类标准）取代 |
| `m7-phases.md` | M7 phase plan | M7 执行期行动大纲。M7 已完成，当前状态见 `../roadmap.md`，收尾审计见 `m7-audit.md` |
| `tech-debt-repaid.md` | 已偿还 TD 完整条目（2026-10-02 冻结迁移） | 条目原文自当时的主表**逐行字节迁移**（不改写、不回写）；这些编号的定义行在本文件 |
| `roadmap-2026-10-14.md` | 2026-10-14 精简前的整份 roadmap | 逐字节冻结，只供查各里程碑当时的完成定义、验收记录与收尾细节，不代表现状；文件内的相对链接以原位置 `docs/` 为基准。仍然有效的规则已移到决定 0078 与 `docs/01-prd.md` §4 |
| `tech-debt-2026-10-13.md` | 2026-10-13 台账重建前的整份旧台账 | 逐字节冻结（有哈希守卫），只供查某个编号当时记过什么，不代表现状；文件内的相对链接按它原来在 `docs/` 下的位置理解 |
| `tech-debt-closed.md` | 已了结清单 | 从台账移出的条目，一条一行，只追加 |
| `opencode-pitfalls.md` | opencode worker 后端的踩坑笔记 | 后端已退役（决定 0105）；代码与测试封存在 tag `archive/opencode-worker-backend`，取回方法见决定 0105 |

## 事故复盘（[`../incidents/`](../incidents/)）

| 记录 | 日期 | 一句话 |
|------|------|--------|
| [DeepSeek-v4-flash quota 耗尽](../incidents/2026-06-17-deepseek-quota-drain.md) | 2026-06-17 | RunManager 终态路径不向 serve 会话发 abort，模型在 serve 端无限多轮生成，当日 quota 烧空 |
| [GLM-5.2 quota 耗尽（dispatch-readiness stop 测试用例）](../incidents/2026-06-18-glm-quota-drain.md) | 2026-06-18 | `stop` 的 abort 回执成功但 serve 会话未真正终止，隔夜失控烧光整周配额；修复落 TD-37/38 |
| [初次实装 Agent 的 E2E 摩擦日志](../incidents/2026-06-26-fresh-agent-e2e-frictionlog.md) | 2026-06-26 | 以首次接触 WAO 的 agent 视角把安装→读说明→派发→轮询→验收全流程实跑一遍，记录流畅处与摩擦 |
| [Worker credential exposure（coder-delivery dogfood 期间）](../incidents/2026-07-12-worker-credential-exposure.md) | 2026-07-12 | 受监督 dogfood 中 worker 读到任务所需凭据之外的 provider 环境数据；凭据轮换、污染件隔离，边界定在决定 0015 |
| [kimi-web backend 接线批](../incidents/2026-09-30-kimi-web-wiring.md) | 2026-09-30 → 10-01 | v1–v11 接线时间线：从轮询启发式竞态三连败到改用原厂 transcript 原语重写，共 11 轮交付、8 审后集成 |
| [EX-2026-09-30-01：T3"绿后推送"一次性具名豁免记录](../incidents/EX-2026-09-30-01-push-exemption.md) | 2026-09-30 | Owner 具名批准的一次性推送豁免专档：交付验证的文件级超时（零断言失败，定性为间歇、未归因）获准豁免"绿后推送"单条门禁、复验义务不免，含作用域、撤销条款与复验收口附录 |
| [MCP 能力解析器镜像漂移误拒 continuable/correctable](../incidents/2026-10-04-continuable-resolver-drift.md) | 2026-10-04 | 能力解析器镜像漂移使带 continuable/correctable 的派发被误拒且零诊断，Lead 一度得出错误兼容性结论 |

命名：`YYYY-MM-DD-slug.md`；例外是一次性具名豁免记录，用 `EX-YYYY-MM-DD-NN-slug.md`。

## 变更日志

| 文件 | 版本与日期 |
|------|-----------|
| [post-M6 修复轮](../changelog-2026-06-17.md) | 2026-06-16 ~ 06-17（另含 06-26 M8 追加） |
| [architecture §1 契约/过程拆分（过程冻结档）](../changelog-2026-08-14.md) | 2026-08-14 |
| [v0.2.0 发版快照](../changelog-2026-10-01-v0.2.0.md) | 2026-10-01 |
| [v0.4.0 发版快照（含 v0.3.x 段指针）](../changelog-2026-10-11-v0.4.0.md) | 2026-10-11 |
| [v0.5.0 发版快照](../changelog-2026-10-16-v0.5.0.md) | 2026-10-16 |
| [v0.6.0 发版快照](../changelog-2026-10-29-v0.6.0.md) | 2026-10-29 |
| [v0.7.0 发版快照](../changelog-2026-10-31-v0.7.0.md) | 2026-10-31 |
| [v0.8.0 发版快照](../changelog-2026-11-02-v0.8.0.md) | 2026-11-02 |
| [v0.8.1 发版快照](../changelog-2026-11-03-v0.8.1.md) | 2026-11-03 |

发版快照的规矩只在 [`../milestone-discipline.md`](../milestone-discipline.md) §9，此处不复述。

## 其他档案入口

- 决定索引：[`../../.wao/decisions/map.md`](../../.wao/decisions/map.md)
- 调研索引：[`../research/README.md`](../research/README.md)
- 封存 tag：`archive/opencode-worker-backend`（[决定 0105](../../.wao/decisions/0105-opencode-worker-backend-retired.md)）、`archive/claude-code-provider-channel`（[决定 0106](../../.wao/decisions/0106-claude-code-provider-channel-retired.md)）

## 引用规则

- 里程碑进度权威：[`../roadmap.md`](../roadmap.md)（它的指针已指向本目录）
- 技术债权威：[`../tech-debt.md`](../tech-debt.md)
- 事故复盘权威：[`../incidents/`](../incidents/)
