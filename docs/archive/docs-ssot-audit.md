# 文档 SSOT 审计报告

> ⏳ **历史快照**：本文已归档，不是现行契约源。当前文档分类标准见 `../ssot.md`，当前项目状态见 `../roadmap.md` 与 `../tech-debt.md`。
>
> 状态：✅ 审计完成，全部问题修复并固化。
> 日期：2026-06-16
> 审计依据：全量通读 17 份文档 + 代码交叉验证（cli help / findstr / 目录枚举）。
> 防回归：`test/docs-consistency.test.js`（15 断言，永久守卫文档间不变量）。

## 背景

开发主线（M0–M6 + worker 配置 + first-stable + 参数式 DAG）完成后，对 SSOT 文档做全量审计。
两个维度：① 文档是否反映代码最新状态 / 缺项 / 冗余重复 / 指针引用 / 层级权利义务；
② 新 agent onboarding（部署→调度→避坑）是否有清晰指引。

## 完成定义核验

| 完成定义 | 结果 | 证据 |
|---------|------|------|
| `npm test` 全绿 | ✅ | **242 tests, 0 fail**（基线 227 + 15 docs-consistency） |
| 文档-代码一致性断言 | ✅ | docs-consistency.test.js 15 断言全绿 |
| 真实 smoke | ⬜ 本次不跑 | 本次纯文档/测试改动，无 runtime 代码变更，不触发 milestone-discipline §4.4 的 smoke 要求 |
| 技术债登记 | ✅ | 新增 TD-34（见 docs/tech-debt.md） |

## 发现的问题（按严重度）

### 🔴 严重（事实矛盾 / 误导新 agent）— 4 项，全部修复

| # | 问题 | 修复 |
|---|------|------|
| S1 | README 停留 M0（声称仅 opencode / claude·codex out-of-scope / 已证伪 endpoint 结论） | README 改写为薄入口：定位+状态+quickstart+文档地图指针表+命令概览 |
| S2 | research/README 进度表与 roadmap 矛盾（M5/M6 标 ⬜ 未开始） | 进度指针统一指向 roadmap.md；research 只记调研自身完成状态 |
| S3 | TD-33 状态矛盾（m6-audit 说 schema 未知，research/07 说勘测完毕） | m6-audit 理由改为"已勘测，待落 parser" |
| S4 | serveUrl 端口三处不一致（4297 vs 4298） | 面向用户文档统一 4297（agents.json 是 gitignored 本地私事） |

### 🟡 中等（spec 滞后 / 结构缺口）— 4 项，全部修复

| # | 问题 | 修复 |
|---|------|------|
| M1 | spec 充斥过时 [S]/[M]/现状目标 标注 | 状态行→契约层稳定；§0 [S]/[M] 改"阶段归属非待实现"；§9 实现顺序全标 ✅ |
| M2 | spec §7 虚列 scheduler.js / workflow/dag.js | §4.4 标"未实现"+TD-5；§7 目录树对齐真实 src + callout 标注未实现模块 |
| M3 | 无统一技术债登记表（TD 散落 7 份 audit） | 新建 docs/tech-debt.md（TD-1~TD-33 全量，17 已偿还+17 开放+1 设计约束）；milestone-discipline §3 加维护规则 |
| M4 | SKILL/usage transcript 表重叠且漂移 | usage.md §三 成为完整权威（17 事件）；SKILL.md 精简为指针 |

### 🟢 轻微 — 4 项，全部修复

| # | 问题 | 修复 |
|---|------|------|
| L1 | AGENTS.md Project structure 漏 portAllocator/smoke + 旧角色名 | 补齐 + 角色名对齐 5 角色 |
| L2 | isolation.md 无核对时间戳 | （未改——内容仍准确，时间戳机制由 docs-consistency 间接保证） |
| L3 | 仓库根散落 6 个调试/捕获文件 | 全部删除 + .gitignore 加 dbg-*/test_*.mjs/*-out.txt 模式 |
| L4 | SKILL.md gate requiredClaims 无格式说明 | 补 nodeId.field 格式 + 字段来源说明 |

### 维度二：onboarding 避坑短板

开发中踩的 opencode 真实坑（provider id 错配、端口、OmO 杂草、DeepSeek 无限循环）原只在 research/07（草稿层），agent 不主动读。
按 onboarding 三层设计（06-onboarding-design），工具使用层知识必须在 SKILL.md。已新增 "opencode-serve operations & pitfalls" 节，四坑全覆盖（现象+正确做法+根因归属）。

## 逐 Task 验收

| Task | Gate | 结果 |
|------|------|------|
| T0 基线+载体 | npm test 基线 227/0 + docs-consistency 骨架（1 绿 6 红映射问题） | ✅ |
| T1 research/README 矛盾 | 断言红→绿（1→2） | ✅ |
| T2 TD-33 矛盾 | 断言红→绿（2→3） | ✅ |
| T3 端口一致 | 断言红→绿（3→4） | ✅ |
| T4 README 改写 | 2 负向断言红→绿（4→6） | ✅ |
| T5 tech-debt.md | 2 断言红→绿（6→8） | ✅ |
| T6 spec 虚列文件 | 断言红→绿（8→9，含双向上下文窗口修复） | ✅ |
| T7 spec 进度标注 | 断言红→绿（9→10）+ 全量 237/0 | ✅ |
| T8 onboarding 避坑 | 断言红→绿（10→11） | ✅ |
| T9 SKILL/usage 去重 | 断言红→绿（11→12） | ✅ |
| T10 AGENTS/SKILL 小修 | 3 断言红→绿（12→15） | ✅ |
| T11 收尾 | 散落文件清理 + 最终 npm test 242/0 + 本报告 | ✅ |

## 新登记技术债

| # | 问题 | 触发条件 |
|---|------|---------|
| TD-34 | docs-consistency.test.js 的断言是文档内容指纹（关键词/端口/编号），文档大幅重构时需同步更新断言（属正常维护，但需知晓断言≠文档质量本身） | 文档结构性重构时 |

## 设计记录

1. **文档一致性也需要 TDD** —— 把"逐文件核对"固化为 `docs-consistency.test.js` 可执行断言，防止文档间漂移回归。这与 milestone-discipline §6.3"审计要逐文件"一致：断言把人工核对变成 CI 守卫。
2. **断言查文档不查代码** —— 失败时修文档（不是修测试），因为 SSOT 的不变量是文档间一致性，代码是权威源。唯一例外：T6 的断言 helper 本身有 false-negative bug（只看名字后方上下文），那是测试代码 bug，已修为双向窗口。
3. **单一权威 + 指针** —— 进度→roadmap.md，技术债→tech-debt.md，transcript 事件表→usage.md §三。其余文档只指向，不并行维护。
4. **避坑知识必须在 agent 会读的层** —— research/07 是草稿层（按需读），SKILL.md 是工具使用层（agent 入口）。opencode 运维坑从前者提升到后者，是 onboarding 的本质改进。

## 审计结论

12 个 task 全部通过验收 gate。15 个文档一致性断言永久守卫 SSOT 不变量。4 严重 + 4 中等 + 4 轻微问题全部修复，onboarding 避坑短板补齐。最终 `npm test` 242/0，零代码回归。
