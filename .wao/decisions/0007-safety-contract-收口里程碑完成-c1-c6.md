# 0007: Safety+Contract 收口里程碑完成（C1-C6）
status: accepted
date: 2026-06-24

## Context
审计核实后的收口完成

## Decision
外部审计 P0-P2 全部处理：C1 node.scorecard传递修复(真bug)+C2 example补tokenBudget+C3 registry validate budget硬门+C4 dataEdge文档对齐+C5状态机spec对齐(改文档不改实现)+C6 _runCleanup接quiet verification(TD-38已修)。opencode两条abort路径(stop+cleanup)都做了静默验证,与S1-1 token闸门共同构成三层防线。runtime-agnostic硬编码(P2)推迟(合理简单,不过早抽象)。372测试绿。

## Consequences
(待补)
