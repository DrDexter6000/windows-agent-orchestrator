# 0001: state read 丰富查询（grep/过滤）
status: accepted
date: 2026-06-23

## Context
S3-2 验收点：核心范围只做 read all

## Decision
阶段3核心范围只做 read all + snapshot。丰富查询（grep决策、按status过滤步骤）留后续。当前 listDecisions 已从 map 读（渐进式披露），state read 同理可扩。

## Consequences
(待补)
