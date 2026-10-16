# 文档 SSOT 架构（Single Source of Truth）

> 状态：契约层。本文是 WAO 文档体系的**权威分类标准**。
> 适用对象：所有人类协作者 + 所有 coding agent（含 Lead / worker / 审计 agent）。
> 关联：`AGENTS.md §Read Before Changes` 是本文件的执行入口。

## 0. 这份文件管什么

两件事：每类信息只能写在哪类文件里（§1–§3），以及每类行动者动手前必须读哪些文件（§0.1）。同一事实写在几处，改一处其余就过时；过程记录和现行契约混在一起，读者分不清哪份是当前真相。这两种漂移都由这里的分类与 `test/isolation-infra/docs-consistency.test.js` 的守卫挡住。

---
### 0.1 tier-1 行动面阅读表——定义：某类行动者行动前不读就会产生错误行为的文档集合；它回答读时必要性，与回答写时归属的五类别正交

| action id | 行动面 | 必读文件 / 入口 |
|---|---|---|
| `repo-change` | 开发 agent 修改代码或文档 | `docs/02-architecture.md`、`docs/roadmap.md`、`docs/ssot.md`、`docs/milestone-discipline.md`、`docs/testing.md`、`docs/usage.md`、`docs/troubleshooting.md`、`docs/surface/`、`SKILL.md`（后四项只在影响对应操作/surface/WAO 操作时读） |
| `m12-containment` | 改 mechanical-containment 产品边界 | `docs/01-prd.md`、`docs/02-architecture.md`、`README.md`、`SKILL.md`、`.wao/decisions/0018-wao-mechanical-containment-no-auto-supervision.md` |
| `contract-edit` | 写当前接口、模型、状态、角色、技术债或进度 | `docs/01-prd.md`、`docs/02-architecture.md`、`docs/team-roles.md`、`docs/tech-debt.md`、`docs/roadmap.md`、`AGENTS.md`、`SKILL.md` |
| `user-first-use` | 第三方 / 用户 agent 首次接入 | `README.md`、`AGENT_ONBOARDING.md`、`llms.txt`、`mcp bind` 输出 |
| `user-config` | 第三方 / 用户 agent 配置 | `AGENT_ONBOARDING.md`、`config/agents.example.json`、`wao doctor` 输出、`mcp bind` 输出 |
| `user-troubleshoot` | 第三方 / 用户 agent 排障 | `docs/troubleshooting.md`、`wao doctor` 输出 |
| `user-daily` | Lead / 用户 agent 日常使用 | `SKILL.md`、`docs/usage.md` |
| `harness-certify` | 给某 harness / LLM 做组件层单独验证（backend conformant / llm verified） | `docs/surface/certification.md`（生成层：backend 能力/配置表达力事实与台账指针；npm run gen:certification 再生成）、`docs/certification-runbook.md`（认证检查结果五态与能力轴分层）、`.wao/decisions/0032-两层验证与认证.md`、`docs/tech-debt.md`（在册限制须随结论一并标注，如 TD-182） |
| `seat-certify` | 给某席位/车道装配做组合层认证（certified / conditional / draft-only；0045 起台账键=车道内容指纹，席位名仅 provenance） | 无条件全文必读：`docs/certification-runbook.md`、`.wao/decisions/0032-两层验证与认证.md`、`.wao/decisions/0045-终局身份模型与0.3.0一步到位合同.md`、`docs/team-roles.md`、`docs/tech-debt.md`。五份不得收窄，也不得按 Lead 裁量收窄（含不得以节选或索引替代）；多行动面命中取并集；正文显式依赖继续跟进；读取输出被截断必须补齐。追加依赖（非独立入口、非节选替代）：判读 containmentEvidence（越界写拦截活体取证）时连读 docs/02-architecture.md §4.6 Coder Delivery Contract（containment 事件合同）与 §4.1 状态机（终态判定）；车道表事实（lane→轴/别名映射）以 config/lanes.json 为数据权威、席位接线模板以 config/agents.example.json 为模板权威（0045 §3） |

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

**铁律**：状态机、事件、backend 接口、角色等当前事实只在唯一真值源定义；只有符合 §2 投影例外的第二份当前值陈述合法。

### 1.2 决策 (Decision) —— 为什么这样定

ADR 风格：一条决策一个文件，定下后归档，只追加"修订"不改写"决定"。WAO 已有 `.wao/decisions/` 层承载运行时决策（状态外化的产物）。**架构级重大决策**也走这里，编号续接。

| 位置 | 内容 |
|------|------|
| `.wao/decisions/NNNN-slug.md` | 单条决策（context / decision / consequences） |
| `.wao/decisions/map.md` | 决策索引（一行只放编号和标题，有形状守卫） |

**与契约的关系**：决策解释"为什么"，契约陈述"是什么"。契约随代码演进；只有在几个备选之间做了取舍时才写一条新决策（体量与小节见 `AGENTS.md` §Documentation），不回改旧决策。一次改动做了什么、怎么验证、谁审的，写进提交说明。

### 1.3 运维 (Runbook) —— 怎么用 / 出问题怎么办

操作向、步骤向。Diátaxis 的 how-to + troubleshooting。

| 文件 | 内容 |
|------|------|
| `AGENT_ONBOARDING.md` | 安装与上手指南 + 贡献者路径 |
| `docs/usage.md`、`docs/usage/*.md` | 使用手册：`docs/usage.md` 是页面地图，`docs/usage/` 下每页对应一项操作任务（部署、车道、宿主、派发、监督、取结果、交付、会审、维护）；`docs/usage/transcript.md` 是 transcript 的入口说明页（事件清单真值源在代码登记表，页面指向生成层清单）；`docs/usage/results.md` 维护尚无生成层的 CLI 查询命令 JSON 输出形状；命令/参数参考在生成层；认证操作正文在下一行的文件，手册里只留具名标题与单向链接 |
| `docs/testing.md` | 开发 WAO 时何时跑全量、何时跑定向测试，worker 交付的验证命令怎么写 |
| `docs/certification-runbook.md` | 认证操作正文唯一权威（`seat-certify` 阅读集合成员）：认证结果用于派发选择的边界、DSH 通道适用限制与能力交叉警告、接入新模型/新运行时、backend 能力对照表（指向生成层）、上游 harness 原语对照、认证与转录维护命令、delta 认证规程、五态与能力轴分层、单次派发覆盖（场景 1b/1c 含 MCP 特有规则）、retry 覆盖继承、认证与当前就绪；使用手册不保留第二份当前正文 |
| `docs/surface/mcp-tools.md` `docs/surface/cli.md` `docs/surface/transcript-events.md` `docs/surface/certification.md` | **生成参考层**：`mcp-tools.md`/`cli.md`（MCP 工具与 CLI 命令的参数/形状）权威源是代码（tools/list 与 CLI help SSOT），由 `npm run gen:surface` 再生成；`transcript-events.md`（转录事件类型清单）权威源是 `src/transcriptEvents.js` 的登记表 `TRANSCRIPT_EVENT_REGISTRY`（写入侧共用序列化守卫保证代码写出的每种事件都已登记），同样由 `npm run gen:surface` 再生成；`certification.md`（backend 六轴能力与配置表达力四轴判定）权威源是 `src/backends/*.js` 类声明与 `validateAgentPolicy` 行为探针，由 `npm run gen:certification` 再生成。四者一律禁止手改，字节稳定由 `docsSurface.test.js` 守卫；改对应权威源后须再生成并提交 |
| `llms.txt` | 仓库根索引（llms.txt 惯例）：只放链接与一句话定位，不承载内容 |
| `docs/smoke-guide.md` | smoke 测试操作 |
| `docs/troubleshooting.md` | 诊断手册（provider/cwd/runs/completion/进程/backend） |
| `docs/milestone-discipline.md` | 发版（§9 检查单，0038 的操作入口）/审计纪律（how-to 性质） |
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

**铁律**：事故复盘**不维护修复进度**——修复状态用一行指针指向 `tech-debt.md` 的 TD 编号。`docs/archive/` 是过程类别的归档子目录（里程碑审计、整份旧台账与旧 roadmap 等冻结快照），头部由 `archive/README.md` 统一标注"非现行契约源"。

### 1.5 调研 (Research) —— 当时是怎么想的

早期草稿、外部调研、架构推演。**不再维护事实**，只追加"已被 X 取代"的标注。

| 位置 | 内容 |
|------|------|
| `docs/research/NN-slug.md` | 调研/推演草稿 |
| `docs/research/README.md` | 调研索引 + 阅读顺序 |

**铁律**：research 里的任何结论被采纳进契约后，research 文件加一行"✅ 已收敛至 02-architecture.md §X / PRD §Y"。research **不作为契约源**被引用。

---

## 2. 三条铁律

1. **一处定义，处处指针**。活文档承载第二份当前值的充要条件是显式写明“投影自 X”且有关系型守卫钉到同一真值源；命名投影只有 `backend-capabilities`（生成层 `docs/surface/certification.md`——由 `scripts/gen-certification.mjs` 从 `src/backends/*.js` 闭集能力成员与 `validateAgentPolicy` 行为探针派生、字节钉守卫）。transcript 事件清单不是命名投影：真值源是代码登记表（`src/transcriptEvents.js`），生成清单 `docs/surface/transcript-events.md` 属生成参考层。
2. **类别不可混放**。根因分析进事故复盘（过程），现象+做法进 troubleshooting（运维），接口定义进 architecture（契约）。跨类别只指针不复制。
3. **过程文档只追加**。事故复盘/mN-audit/research 定格后不改写事实；修复状态、被取代状态一律用指针，不回改正文叙述。

---

## 3. 写新文档前的强制流程

> `AGENTS.md §Read Before Changes` 指向本流程。任何 agent（含人类）想新建 .md 文件时，**先回答三个问题**：

1. **这个信息属于哪个类别？**（契约/决策/运维/过程/调研）—— 不确定就属于已有类别的补充，不该新建。
2. **权威源是不是已经存在？** —— 95% 的情况答案是"已存在，应该改它而不是新建"。新建文件要说得出理由：现有文件装不下这类信息，或者现有文件大到读者无法整读、需要按操作任务拆页。
3. **我会不会复制别处的正文？** —— 会的话，改成指针。

**默认答案是"不新建"**。新建 .md 的合理场景：新的事故复盘（过程类别，按日期命名）；新的 ADR（决策类别，按编号命名）；一份参考文档大到读者无法整读时，按读者要完成的操作任务拆成各自完整的专题页。

认证操作正文单独成文件（`docs/certification-runbook.md`），是因为 `seat-certify` 要求无条件全文阅读一份自足的正文；使用手册在原位置只留具名标题与指向它的单向链接，不保留第二份正文。拆页的单位是完整正文，不是锚点清单或节选。

---

## 4. 当前守卫

SSOT 规则用 `test/isolation-infra/docs-consistency.test.js` 固化。守卫重点不是"文档质量打分"，而是防止已知漂移重新出现：

- 旧 worker 名不得出现在面向 lead/user 的入口文档。
- 状态机完整状态列表只在 `docs/02-architecture.md` 维护。
- transcript 事件登记表在 `src/transcriptEvents.js` 维护（冻结闭集；`src/transcript.js` 所有写出口共用的序列化守卫保证代码写出的每种事件都已登记，测试基建开严格模式）；生成清单 `docs/surface/transcript-events.md` 由 `npm run gen:surface` 产出，`docs/02-architecture.md` §3.2 与 `docs/usage/transcript.md` 只指向它，不维护表格。
- 技术债台账 `docs/tech-debt.md` 一条一行、列数与状态固定、行长有上限；每个技术债编号只在台账、已了结清单（`docs/archive/tech-debt-closed.md`）、已偿还归档三者之一有定义行，文档与代码里引用的编号都要有定义（测试夹具与冻结的归档不在检查面）。
- 决定索引一行只放编号和标题；新决定档有体量上限。
- 历史审计和 phase plan 必须在 `docs/archive/`，不能回到 docs 根目录充当活文档。
- seat-certify 入口：§0.1 的行无条件全文必读恰五个文件；多行动面取并集、正文显式依赖跟进、截断补读三项义务在场；containmentEvidence 连读 architecture §4.6/§4.1 是追加依赖指针，不是独立入口；改成索引、节选替代全文或按裁量收窄都会红。
- 认证正文迁出处：使用手册保留具名标题与指向 `docs/certification-runbook.md` 的单向链接，目标节必须真实存在；摘链接、改目标节名、删标题都会红。
- 使用手册：`docs/usage.md` 的页表与 `docs/usage/` 下的文件一一对应，每页开头指回地图，页内相对链接都能解析到文件；派发页的续跑拒绝原因与代码闭集双向一致。
- roadmap：里程碑表里已完成的里程碑不回退；字节上限把它限在一张表的体量。
- 车道当前型号只写在配置里（`config/lanes.json` 与 `config/agents.example.json` 的 `model.id`、认证矩阵的 `modelId`/`label`）：现行文档与模板注释写车道绑定用车道名或 `<modelId>` 占位；描述具体型号的事实放进成对的 `<!-- model-specific -->` … `<!-- /model-specific -->` 就地标记（文档里提及标记语法须成对写出）。
- 字节上限：几份大的活文档各有字节上限；上限红了就搬走或删去内容，抬高上限由 Owner 决定。

历史审计矩阵不在本文维护；需要查当时发现和收束过程时读 `docs/archive/docs-ssot-audit.md`。当前项目状态以 `docs/roadmap.md`、`docs/tech-debt.md`、`docs/02-architecture.md` 和代码/测试为准。
