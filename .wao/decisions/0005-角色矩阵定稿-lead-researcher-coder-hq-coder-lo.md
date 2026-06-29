# 0005: 角色矩阵定稿：Lead/Researcher/Coder-HQ/Coder-Low/Coder-MM/Tester/Auditor
status: accepted
date: 2026-06-23

## Context
codex onboarding暴露401+配置散乱+安装位置歧义后,owner定的角色驱动重整方案

## Decision
Lead=runtime自己不进registry(默认codex GPT5.5 xhigh)。Researcher=claude-code wrapper deepseek-v4-flash max(进程式,弃opencode)。Coder-HQ=claude-code wrapper glm-5.2 high。Coder-Low=claude-code wrapper glm-5-turbo(轻活)。Coder-MM=kimi-code kimi-for-coding(多模态)。Tester=codex GPT5.5 medium+轮询职责。Auditor=claude-code Opus4.8 xhigh+前置审计(方案阶段)+后置验收。WAO装一次开发多项目:skill装runtime目录,每目标项目建.wao/。

## Consequences
(待补)
