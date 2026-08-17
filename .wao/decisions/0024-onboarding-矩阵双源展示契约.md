# 0024: onboarding 矩阵双源展示契约
status: accepted
date: 2026-08-17

## Context
R11-2（Owner 批准，coder_mm 咨询定稿）。R10-B 只把会审就绪块切到已配置面（私有
config/agents.json 在场且可读时），矩阵本体仍只显示模板行——同一屏两个口径（矩阵说
模板、就绪块说"真实状态以它为准"）。本决策把矩阵本体双源化：已配置行（真实状态）在前 +
模板未配置候选在后，"标少数派"形态。0022(6)（"所有标签从入库模板行生"）需扩展为
"标签从输入行生 + 来源标记"——私有行也生标签但带来源标记；禁止硬编码角色名的精神不变。

## Decision
**supersedes 0022 的条款 (6)**（其余五条保留，见下）："所有标签从入库模板行生，禁止
硬编码角色名" → "标签从输入行生（已配置行 = 私有 registry 行、模板候选行 = 模板行）
+ 行级来源标记（source 字段）"；禁止硬编码角色名的精神不变（全部行仍由输入行派生，
无手写角色表）。

**矩阵双源展示契约**：
1. 私有 config/agents.json 在场且可读时，矩阵 = 已配置行（真实状态）在前 + 模板未配置
   候选在后；表头一句交代混合：`矩阵 = 你的 config/agents.json（N 名）+ 模板未配置候选
   （M 名）`（N = 私有有效行总数——过 normalizeAgent 的条目；M = 模板行数 − 私有同 id 行数）。
2. 已配置行按私有 registry 顺序稳定展示，不打来源标；模板候选行组内沿用 ready-first
   既有排序，行尾紧凑标记 `·模板候选`。
3. 行级结构化来源字段（JSON 面）：recommendations 行携带 `source: "configured"|"template"`
   ——renderHuman 与 --json 同源单对象，展示尾标只是它的投影（JSON 消费者拿得到双源事实）。
4. 同 id 漂移（drift）：私有胜显示；比对闭集仅 backend + model.id（两侧读 `.model?.id`；
   opencode legacy 形状的 providerID/variant/contextWindow 不比——形状差异 ≠ drift）；
   漂移行行 1 尾挂 `·drift` 紧凑旗标；表后每 drift id 一条有界明细（`drift: <id> 私有
   model=X/backend=Y ≠ 模板 X'/Y'`，展示 ≤3 条 + "另有 K 条"尾注）。纯展示零行为。
5. 私有独有行：模板没有的 id 照常显示（backend/model/状态/认证 + seatRole 声明——
   registry 字段非模板专属）；"适合:"段整段省略（来自模板 _comment_task，私有行没有；
   不打 "?"——缺席不是坏值）；禁止 systemPrompt 指针代入角色提示（机制路径不进有界展示面）。
6. 排序/截断上界：私有行 ≤ MAX_CANDIDATES（64），模板补到 64 − 私有已显；私有独占上限
   时模板显 0 + 尾注指向 config/agents.example.json；模板溢出尾注"另有 K 名模板候选未
   显示"；帽不可被"私有全显"架空。
7. 既有面回归：私有缺位 = 现状模板面逐字不变；私有不可读回退模板面（sourceUnreadable
   标注既有，R10-B）；R10-B 就绪块已配置面 / R10-C C-2 无效条目剔除与矩阵改造同屏共存；
   表尾既有句扩一词："--apply 仅适用模板候选行"——防误选语义全部由这一句承担，不做
   逐行"可 --apply/已配置"双标（列宽纪律）。

**定位红线（不变）**：纯展示零行为——不改变 --apply/--endorse-worker 的拒绝/写入语义，
不改 registry 校验权威（normalizeAgent 单一权威），不新增门禁；0022 其余五条（backend
列 / 登录态行写明具体 CLI / auditor 在场 / coder 通道互为会审备选措辞 / 显示宽列宽纪律）不动。

## Consequences
- **落地面清单**：`src/application/onboarding.js`（双源矩阵组装 + rows.source/drift +
  有界事实字段（configuredCount/templateCandidateCount/templateOmitted/privateOmitted））、
  `src/commands/onboarding.js`（表头混合句/行尾标/drift 明细与截断尾注/表尾句扩词——全部
  是 recommendations 单对象的投影，渲染层不写第二事实源）、`AGENT_ONBOARDING.md` §4c 双源
  说明、`docs/usage.md` 配置节追加说明、测试（onboarding.test.js 双源状态矩阵 +
  docs-consistency.test.js 关系型锚）。
- **0022 supersede 影响**：0022(6) 被取代（模板行生 → 输入行生 + 来源标记）；其余五条保留
  引用；0022 头部已加 superseded-by: 0024（条款 6）反向指针（导航事实，历史决策正文不
  改写，status: accepted 保留——0019:4 先例）。
- **对消费者的行为变化**：已有私有 registry 的用户裸跑 onboarding 会在矩阵同时看到自己的
  真实配置行（含 drift 标注）与未配置的模板候选；模板候选行尾标 + 表尾句"（--apply 仅适用
  模板候选行）"指明 --apply 的适用范围；无私有 registry 的新消费者输出逐字不变。
