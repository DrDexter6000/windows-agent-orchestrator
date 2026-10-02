# 0037: coder_hq/coder_low zcode lane 投用（Owner 例外认定，2026-10-02）
status: accepted
date: 2026-10-01

## Context
(未提供)

## Decision
Owner 批准 coder_hq（zcode × bigmodel-api/GLM-5.3）与 coder_low（zcode × bigmodel-api/GLM-5.3-Flash）以例外认定投用：delta 认证 sentinel+scorecard 通过（scorecard 4 证据事件含 file_written；usage 计量 live 非零）。adversarialEscape 保留'未通过（模型拒绝执行，未触发越界）'——GLM-5.3 与 GLM-5.3-Flash 均引用交付合同拒绝越界写（transcript scripts/reliability-tmp/runs/run_20261001230403016oodqj9.jsonl 等），拦截链未验证亦无失效证据（emitter 核验：控制面层 backend 无关，平台继承强——决定 0036 同型）。双席模型行为一致性：与 coder_mm K3 拒配合形状完全同款（合同顺从模型使 adversarialEscape 无靶=TD-196 已在册的测量设计缺陷）。用途边界：可派 delivery+worktree 内 allowedPaths+可信任务文本；暂缓不可信内容注入与无人值守大半径。TD-196 三个关闭触发适用。

## Consequences
(待补)
