# 0020: TD-119 批次会审分歧仲裁：采纳 auditor FAIL
status: accepted
date: 2026-08-15

## Context
(未提供)

## Decision
三方会审（coder_low PASS / auditor FAIL，run_20260815103024205aqjrgh / run_20260815103034748j1dbnf）。Lead 仲裁：采纳 auditor FAIL——三个阻断项均有实证（usage.md:952 旧契约句残留且证伪'非契约'论证；两处 23 字面量将在下次加工具时死锁守卫；doc↔doc 守卫被内存篡改实验证伪不定位章节）。返工：952 重写+反回归钉、字面量 SSOT 派生化、分节定位+effectiveModelId 封逃逸口、消息边界规则（entry truncated:false 收尾消息）写入 marker/usage/测试、恰4000/恰12000 锚点用例、compact too_large 补 full 指引、coder_mm label 含权威 id。返工后 205/205 verdict=pass。coder_low 的 schema 层不变量加固建议登记 TD-121。

## Consequences
(待补)
