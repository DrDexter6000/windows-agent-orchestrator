# 0002: 单 agent 调 subagent 的 handoff 自动化
status: accepted
date: 2026-06-23

## Context
S3-4 边界：先 WAO→worker

## Decision
阶段3先做 WAO→worker 交接（writeHandoff/readHandoff 已实现）。单 agent 自己调 subagent 时如何自动生成 handoff 卡（而非 agent 手动调命令）留后续。需先在实战中观察单 agent 场景的交接频率再决定自动化程度。

## Consequences
(待补)
