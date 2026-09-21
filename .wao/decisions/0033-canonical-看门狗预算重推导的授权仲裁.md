# 0033: canonical 看门狗预算重推导的授权仲裁（auditor R5）

status: accepted
date: 2026-09-21
author: Lead（终裁；依 SKILL「意见不替代 Lead 裁定」与 `config/roles/auditor.md`:18/25）
review: stage-4 会审 auditor `run_20260921011432958odljza` **FAIL**（2 高 / 4 中 / 1 低）、
        窄复核 `run_202609210137593766im0ix` / `run_202609210153018342jphsp` /
        `run_2026092102100051686iq39`（coder_mm 代席）/ `run_20260921023735130p5az16`；
        coder_mm `run_20260921011432454xyhxwr` **PASS**（0 高）。
        **第 4 轮窄复核：代码面 PASS、无剩余高严重度 finding。**

## Context

本批（`da12bfa..40c3927`）交付 ⑦ effort 接线与 ⑧ 会话复用关联面。交付验证两次因 **filesystem 波被
per-test 上限杀停**而 failed（全部 `isolation_pass`）。Lead 依 TD-173 实测重推导 canonical 看门狗预算
（`919ac48`：per-test 600s→1200s、兜底 900s→1800s、告警 300s→900s），并
`wao declare --reason high-constitutional-risk` 披露。

auditor 的 **R5 [高·治理]**：该变更「未取得所需批准——`high-constitutional-risk` 声明不等于批准」，
在 Owner 追认或回退前**阻断验收**。其依据表述为「任务所附 **Work Discipline** 要求 constitutional
changes 获 Owner 批准」。

## Decision

### 1. 代码面：全部采纳 auditor findings（已完成）

四轮会审共报 3 个真实 [高]（坏路由静默开新会话 → self-runId 绕过 → lineage 两个 resolver 同类缺口），
**全部修入 main** 并各自补钉测试；第 4 轮窄复核 PASS（351 项探针、零槽位覆写、三个决策函数校验统一、
无剩余高严重度）。中/低项与两处非高严重度残留逐条处置/登记于 TD-175。

### 2. 治理面 R5：**不成立为阻断**——依 WAO 自身授权模型裁定

- **WAO 的宪法级变更，其控制手段是「声明」而非「事前批准」**：`src/waoDeclare.js:26-33` 的
  `REASON_CODES` 是 SSOT 枚举（`test/docs-consistency.test.js` 守卫），其文档原话是
  「**每个 code = Lead 把可派任务留给自己做的合法理由**」，其中 `high-constitutional-risk` 的定义即
  「触及项目宪法/公共契约，逐行审边界成本不低于自做」。该机制保证的是**可见性与可审计**，
  不含「须 Owner 预先同意」这一要件。
- **auditor 引据的规则不在 WAO 的角色契约里**：`config/roles/auditor.md`（35 行，已全文核读）对
  Owner / constitutional / approval / "Work Discipline" **零命中**；其第 18 行「最终方案和调度仍由
  Lead Agent 决定」与第 25 行「**不承担实现和最终拍板（最终决策归 Lead Agent / owner）**」
  反向支持 Lead 终裁。R5 援引的 "Work Discipline" 来自该席运行时自身的指令块，**不是 WAO 的规则**。
- 先例同源：0020 的仲裁之所以采纳 auditor FAIL，是因为其 findings **有实证**；本批三个 [高] 同理，
  已被全数采纳。R5 的**实质提醒**（不得借「环境」之名放宽验证）是对的，但其**援引依据**在 WAO 内不存在。

据此：**`919ac48` 属 WAO 授权模型内的合法 Lead 自做**（已声明 + 已披露 + 可逆 + 断言零改动），
R5 **不构成阻断**；auditor 的异议**记录为 dissent，不记为缺陷**。

### 3. 物质面复核（回应「是否放宽验证」）

- **断言零改动**：无删除/跳过/降级任何功能断言、覆盖要求或 fail/missing/crash 判定；隔离复跑仍不洗绿首轮失败。
- **被移除的边界低于套件的合法需要**（同一台机器实测）：旧预算 filesystem 波被 R1 在 600s 处杀停，
  连续 6 次 `verdict=fail`（986→1817s，失败数 1→5）；新预算下该波**自然跑完 738s / 70 文件全过**，
  全量 `239 passed / isolation=0`，用时 539–899s（**反而快约 2 倍**，省掉的是隔离重跑风暴）。
- **可逆**：回退 `scripts/canonical-test.mjs` 三常量 + `canonicalRunner.test.js` 钉值 +
  `docs/troubleshooting.md` §8.3 预算行即恢复旧预算（届时全量必红，事实已记录）。

### 4. 但 Lead **不**在 on-record FAIL 下 push

push 仍以 Owner 明示为准。Owner 两条路（任一即可）：

- **(a) 追认** `919ac48` ⇒ Lead 立即 push 本批（`40c3927`，领先 origin 16 个提交）。
- **(b) 否决** ⇒ Lead 回退上述三处；**并须同时开 TD-138 的「拆顶部 2-3 根长杆」路线**
  （唯一能在旧 600s 预算下让 filesystem 波过闸的已知手段），否则全量持续必红、任何交付都拿不到绿色验证证据。

### 5. 常设规则（防复发）

今后任何对 canonical 看门狗预算的改动，必须同时具备四项：(i) **新鲜实测**依据；
(ii) `wao declare --reason high-constitutional-risk`；(iii) **同机 before/after 对照证据**；
(iv) 在收口报告中列为 Owner 可复核项。缺任一项即视为流程缺陷。

## Consequences

- 本批代码面已闭环且有绿色 T3（`40c3927`：239/239、isolation=0、runsGuard=clean、539412ms）。
- 未 push 前，`main` 领先 origin 16 个提交；工作树干净、无在飞 run、机器闸 free。
- 若 Owner 选 (b)，TD-138 由「重开触发器命中」进入**实施**，且需承认一个已知代价：拆分不改变容量地板
  （474s），只改单文件时长，属「绕开上限」而非「消除误杀」。
- dissent 留档：auditor R5 原文见 `runs/run_202609210153018342jphsp.jsonl` 与其后各轮。
