# 决定 0042：--agent 退出码归属 + 卫生 advisory 弹行规则（Owner 2026-10-02 裁定）

## 背景

Lead 体验复盘批（TD-202/TD-203）暴露两个治理面问题，Owner 于 2026-10-02 明示裁定。

## 决定

**一、TD-203 退出码归属**：`npm run reliability -- --agent <id>` 的退出码**只由目标 lane 的检查结果决定**——ambient 段（fallback-lane 的 silentTimeout 探针）真失败不翻 allPass/退出码，只在 `[ambient]` 标注行如实可见；全量模式语义不变（ambient 失败仍算整次失败）。

**二、TD-202 卫生 advisory 弹行规则**（治警报疲劳——旧实现每次派发恒弹，单日 20+ 次，Lead 已视而不见）：
1. **只在数字变化时弹**（与上次弹出的计数一致则静默；下降也弹一次——清退值得看见）；
2. **帽内且无变化不弹**（健康态静默）；
3. **超帽恒弹**（违规保持可见直至清退——配合下条，违规无法靠抬帽消失）。

**三、分支帽只降不升**：`BRANCH_CAP` 的 SSOT 自 `scripts/hygiene.mjs` 迁至 `src/dispatchResourceAdvisory.js`（hygiene re-export 消费；单一定义保持，ADR 0035 §Decision 3 的"单一位置"语义不变、位置随本决定修订）。**上调须 Owner 明示并同步双侧只降钉**（dispatchResourceAdvisory.test.js + hygieneGitState.test.js）——2026-10-02 的 175→185 系最后一次抬升（M13-r1 交付解锁，经 declare 登记）。

## 后果

- 状态文件（上次弹出的计数）落 `%LOCALAPPDATA%\wao\dispatch-advisory-<repoHash>.json`，只存两个整数；读失败 → 视为变化保守弹一次（状态损坏不吃掉信号），写失败 → 静默（下次重弹）。
- advisory 行文案不变（两计数 + hygiene 指路）；fail-open 纪律不变。
- 实施批：dispatchResourceAdvisory 三次子进程（+rev-parse 作状态键）；决定 0042 测试三钉（变化/超帽/只降）。
