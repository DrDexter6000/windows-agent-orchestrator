# 文档 SSOT 架构（Single Source of Truth）

> 状态：契约层。本文是 WAO 文档体系的**权威分类标准**。
> 适用对象：所有人类协作者 + 所有 coding agent（含 Lead / worker / 审计 agent）。
> 关联：`AGENTS.md §文档纪律` 是本文件的执行入口（写新文档前必读）。

## 0. 为什么需要这份文件

WAO 曾在 2026-06-16 做过一次 SSOT 审计（`docs/archive/docs-ssot-audit.md`），建立了"单一权威 + 指针"原则和一致性断言。但那次审计解决的是**文档间内容矛盾**（端口不一致、进度表漂移），没有解决两个更深的问题：

1. **分类边界缺失** —— 没有规定"哪类信息只能放在哪类文件里"。结果是同一事实（如状态机定义）被全文复制到 5 个文件，任何一处改动其余 4 处就 stale。06-18 事故复盘头部至今仍写"未修复"而代码已修，就是这种结构的必然产物。
2. **过程文档与契约文档混放** —— `research/` 草稿、`m0~m6-audit.md` 快照、`changelog` 与现行契约（PRD/spec/tech-debt）平级存在，读者（尤其 agent）分不清哪份是当前真相。

本文件用两个机制收口：**类别归属（§1）** + **写新文档前的强制检查（AGENTS.md §文档纪律）**。

---

## 1. 核心架构：五大类别

借鉴 Diátaxis（四象限文档法）+ ADR/RFC（决策记录）+ 项目实际，WAO 文档分**五个不可混放的类别**。每条信息**只能属于一个类别**，在所属类别的**唯一权威源**里定义，其余文件只写指针。

### 类别速查表

| 类别 | 回答的问题 | 性质 | 是否随代码演进 | 允许用文件夹+地图？ |
|------|-----------|------|--------------|-------------------|
| **契约 (Contract)** | "系统**当前**是什么" | 不可变约束、当前接口/行为 | ✅ 随代码同步 | 是（见 §1.1） |
| **决策 (Decision)** | "为什么这样定" | ADR，定下后归档 | ❌ 只追加不改写 | 是（见 §1.2） |
| **运维 (Runbook)** | "怎么用 / 出问题怎么办" | 操作步骤、诊断手册 | ✅ | 是（见 §1.3） |
| **过程 (Process Log)** | "当时发生了什么" | 事故复盘、里程碑审计、changelog | ❌ 时间冻结快照 | 是（见 §1.4） |
| **调研 (Research)** | "当时是怎么想的" | 早期草稿、推演、外部参考 | ❌ 不再维护事实 | 是（见 §1.5） |

**关键区分**：契约/运维是"活的"（改了要同步代码），决策/过程/调研是"死的"（定下/发生后冻结，只追加不回改）。把活文档的句子复制进死文档，是漂移的头号来源。

### 1.1 契约 (Contract) —— 系统当前是什么

**唯一允许定义接口、数据模型、状态机、行为契约的地方。** 别处引用只能写"见 `02-architecture.md §X`"。

| 文件 | 权威范围 |
|------|---------|
| `docs/01-prd.md` | 产品定位、目标用户、验收标准（PRD §8） |
| `docs/02-architecture.md` | 技术架构、**状态机定义**、模块边界、事件 schema、接口契约 |
| `docs/team-roles.md` | 角色矩阵（唯一权威） |
| `docs/tech-debt.md` | 技术债唯一登记表 |
| `docs/roadmap.md` | 里程碑进度唯一权威 |
| `AGENTS.md` | 仓库工作纪律（agent 视角） |
| `SKILL.md` | orchestrator 使用手册（worker/Lead 视角） |

**铁律**：状态机的状态列表、transcript 事件类型表、backend 接口签名、角色定义 —— **全文只允许出现在本类别的一个文件里**。PRD 可以提"显式状态机"这个概念，但不许列出 `pending→submitted→running→终态` 全文（那是 architecture 的权威）。

### 1.2 决策 (Decision) —— 为什么这样定

ADR 风格：一条决策一个文件，定下后归档，只追加"修订"不改写"决定"。WAO 已有 `.wao/decisions/` 层承载运行时决策（状态外化的产物）。**架构级重大决策**也走这里，编号续接。

| 位置 | 内容 |
|------|------|
| `.wao/decisions/NNNN-slug.md` | 单条决策（context / decision / consequences） |
| `.wao/decisions/map.md` | 决策索引（一行一条，不放正文） |

**与契约的关系**：决策解释"为什么"，契约陈述"是什么"。契约可以变（随代码演进），但变了要追加一条新决策说明为什么变，不回改旧决策。

### 1.3 运维 (Runbook) —— 怎么用 / 出问题怎么办

操作向、步骤向。Diátaxis 的 how-to + troubleshooting。

| 文件 | 内容 |
|------|------|
| `docs/usage.md` | 部署、命令、transcript 事件表（唯一权威） |
| `docs/smoke-guide.md` | smoke 测试操作 |
| `docs/troubleshooting.md` | 诊断手册（provider/cwd/runs/completion/进程/backend） |
| `docs/milestone-discipline.md` | 发版/审计纪律（how-to 性质） |
| `docs/isolation.md` `docs/port-allocator.md` | 单模块操作说明 |

**铁律**：坑/故障的"现象+做法"写这里；根因分析/教训写过程类别（事故复盘）。运维文档可指向事故，但**不复制事故正文**。

### 1.4 过程 (Process Log) —— 当时发生了什么

时间冻结快照。发生过就定格，不改写（除非修正事实错误并标注）。

| 位置 | 内容 |
|------|------|
| `docs/incidents/YYYY-MM-DD-slug.md` | 事故复盘（经过+根因+教训+修复指针） |
| `docs/changelog-*.md` | 变更日志 |
| `docs/archive/mN-audit.md` | 里程碑审计（历史快照，已归档；见 `docs/archive/README.md`） |
| `docs/archive/docs-ssot-audit.md` | 历史 SSOT 审计快照 |
| `docs/archive/m7-phases.md` | M7 完成后的 phase plan 历史快照 |

**铁律**：事故复盘**不维护修复进度**——修复状态用一行指针指向 `tech-debt.md` 的 TD 编号。这是 06-18 复盘 stale 的直接修复点。`docs/archive/` 是过程类别的归档子目录（mN-audit 等冻结快照），头部由 `archive/README.md` 统一标注"非现行契约源"。

### 1.5 调研 (Research) —— 当时是怎么想的

早期草稿、外部调研、架构推演。**不再维护事实**，只追加"已被 X 取代"的标注。

| 位置 | 内容 |
|------|------|
| `docs/research/NN-slug.md` | 调研/推演草稿 |
| `docs/research/README.md` | 调研索引 + 阅读顺序 |

**铁律**：research 里的任何结论被采纳进契约后，research 文件加一行"✅ 已收敛至 02-architecture.md §X / PRD §Y"。research **不作为契约源**被引用。

---

## 2. 三条铁律

1. **一处定义，处处指针**。同一事实（状态机、事件表、角色、端口约定）全文只在权威源出现一次。别处引用写"见 `<file> §<heading>`"，不复制正文。
2. **类别不可混放**。根因分析进事故复盘（过程），现象+做法进 troubleshooting（运维），接口定义进 architecture（契约）。跨类别只指针不复制。
3. **过程文档只追加**。事故复盘/mN-audit/research 定格后不改写事实；修复状态、被取代状态一律用指针，不回改正文叙述。

---

## 3. 写新文档前的强制流程

> 这一条是 `AGENTS.md §文档纪律` 的展开。任何 agent（含人类）想新建 .md 文件时，**先回答三个问题**：

1. **这个信息属于哪个类别？**（契约/决策/运维/过程/调研）—— 不确定就属于已有类别的补充，不该新建。
2. **权威源是不是已经存在？** —— 95% 的情况答案是"已存在，应该改它而不是新建"。新建文件需要能说出"现有 5 类文件都装不下这个信息"的理由。
3. **我会不会复制别处的正文？** —— 会的话，改成指针。

**默认答案是"不新建"**。新建 .md 的合理场景只有两种：(a) 新的事故复盘（过程类别，按日期命名）；(b) 新的 ADR（决策类别，按编号命名）。其余需求一律落到现有文件。

---

## 4. 当前守卫

SSOT 规则用 `test/docs-consistency.test.js` 固化。守卫重点不是"文档质量打分"，而是防止已知漂移重新出现：

- 旧 worker 名不得出现在面向 lead/user 的入口文档。
- 状态机完整状态列表只在 `docs/02-architecture.md` 维护。
- transcript 事件表只在 `docs/usage.md` 维护，`SKILL.md` 只指针引用。
- 技术债编号必须能在 `docs/tech-debt.md` 查到。
- 历史审计和 phase plan 必须在 `docs/archive/`，不能回到 docs 根目录充当活文档。

历史审计矩阵不在本文维护；需要查当时发现和收束过程时读 `docs/archive/docs-ssot-audit.md`。当前项目状态以 `docs/roadmap.md`、`docs/tech-debt.md`、`docs/02-architecture.md` 和代码/测试为准。
