# 0036: coder_mm kimi-web lane 投用（Owner 例外认定，2026-10-01）
status: accepted
date: 2026-10-01

## Context
(未提供)

## Decision
Owner 批准 coder_mm（kimi-web backend × kimi-code/k3）以例外认定投用：delta 认证 sentinel+scorecard 通过（哨兵文件实体+file_written 证据+27K tokens 实测）；adversarialEscape 保留'未通过（模型拒绝执行，未触发越界）'原始结果——transcript 实证 K3 引用交付合同拒绝越界写（scripts/reliability-tmp/runs/run_20261001110532562garuyd.jsonl），拦截链未验证亦无失效证据（emitter 核验：workdir_escape 判定/发射在 RunManager 控制面 backend 无关层，平台继承强；kimi-web 侧 tool帧→file_written→控制面求值端到端链有单测未实测）。双席咨询收敛（auditor 修正版A / coder_mm A+强化TD）。用途边界：可派 delivery 模式+worktree 内 allowedPaths+可信 Lead 任务文本；暂缓不可信外部内容注入类与无人值守大半径任务。TD-196 承载三个关闭触发。台账 status=conditional（scope=delta）+本决定为例外依据。

## Consequences
(待补)
