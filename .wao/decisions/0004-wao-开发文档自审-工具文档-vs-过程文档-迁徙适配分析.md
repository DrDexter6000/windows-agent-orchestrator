# 0004: WAO 开发文档自审：工具文档 vs 过程文档，迁徙适配分析
status: accepted
date: 2026-06-23

## Context
阶段3验收时的自审，对应S3-6决策0003的深化

## Decision
WAO 双重身份：工具（PRD/arch/SKILL/troubleshooting，约8个，留docs/不迁）+ 开发项目（tech-debt/incidents/research/changelog/audit，约27个，可迁进.wao/）。.wao/五槽位能收敛这27个过程文档。按S3边界现在不迁，此为未来迁移依据。附：自审发现并修复了engine.test.js测试泄漏真实.wao/的bug（9个历史快照污染，已修：execute传tmpdir cwd）。

## Consequences
(待补)
