# 0124 收口等待证明不了 runner 已不在时以退出码 5 报警；开机事实只陈述、不放行

- 日期：2026-11-12
- 状态：accepted
- 来源：
  - 宿主项目反馈 `fb_20261111T190914Z_9smrew`：主机重启杀掉了一个运行的 runner，运行一直是 `running`，Lead 挂在后台的 `runs wait --until-settled` 两个多小时既不退出也不告警。
  - 方案会审 `consult_20261112095946942740ift`（kimi RETHINK、sol PROCEED_WITH_CHANGES），交付会审 `consult_20261112110927801zokcva`（sol、deepseek-flash）。
  - 第 107 批。
- 关系：补充决定 0095（收口等待）的退出码闭集与第 83 批的 runner 缺席证明；不改 0120（runner 经 WMI 启动桥起）。

## 背景

runner 缺席证明是 `runs settle` 的只读干跑。事故里它拒于 `runner_scan_failed`：本机有一个开机后创建、命令行读不到的 node（宿主自己的 session 0 常驻进程），扫描排除不掉。拒绝理由只写进进度行，而后台等待的宿主只在进程退出时唤醒 Lead。

## 决定

1. 等待器新增结果 `runner_unproven`，CLI 退出码 5（`runs wait --until-settled` 与 `consult wait --until-settled` 同一套）。条件：本轮确实发了证明（owner 心跳不新鲜、满结算静默窗），证明被"证明不了"一类的闭集理由拒绝（`runner_scan_failed`、`process_identity_unknown`、`owner_lease_corrupt`、`session_ambiguous`、证明抛错记成的 `probe_failed`），且计入静默窗的最后绑定事件已满 30 分钟（`LEAD_ADVISORY_QUIET_SECONDS`）——证明那一轮的快照与报警前重读的快照都要满足，重读时长出新事件就不报警。正面存活证据（心跳新鲜、仍见 runner 或会话进程、有活 daemon）、前台无会话与有停止通道的形状照旧一直等。
2. 退出时只陈述：证明不了 runner 已不在，运行仍可能变化；不写"等下去也不会变"。下一步先看 `wao status`，再干跑 `runs settle` 看门事实；停掉、结算或重挂由 Lead 决定。WAO 不改运行状态。
3. 本机开机晚于该运行最后可见活动（最后绑定事件与 owner 租约心跳取较晚者）时，退出输出与 `run_status` 的静默 advisory 各说一句：重启前的 runner 活不过重启，开机后有没有续跑未经证明。它是陈述，不是证明。

## 不采纳

- **开机晚于最后活动就不让命令行读不到的进程拦截证明**：开机后有人续跑同一 runId（前台 `resume --wait` 先起进程、后写 `run.rerun`；后台 resume 的心跳写失败会被吞掉），且那个进程命令行读不到时，它在写下第一条事件之前会被误判成"已不在"，Lead 可能据此错误结算。两席方案会审都给出这个反例。
- **WAO 启动或 preflight 时自动把这类运行判成终态**：重启事实只证明旧进程不在，不证明没有新的承载者；自动写终态会把观察的不确定变成持久状态，绕过 `runs settle` 只在 Lead 显式 apply 时才写的边界。
