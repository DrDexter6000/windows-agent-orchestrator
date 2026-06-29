# WAO Safety Incidents — 必读背景

> 本文件是 SKILL.md "安全铁律" 的详细背景。主控在第一次使用 WAO 前、或遇到 opencode worker 异常时读它。
> 这里记录的真实事故，是每条铁律存在的理由。读懂它们，你才知道为什么规则这么定。

## 事故 1：06-17 DeepSeek quota 耗尽（TD-35）

**发生了什么**：一次 DeepSeek researcher run 超时后，RunManager 只写了 `run.timed_out`，没有调用 serve session abort。DeepSeek 在后台持续生成，数小时耗尽当日 quota。

**根因**：RunManager 的终态路径（completed/failed/timed_out）都不调 `handle.abort()`。HTTP 类 backend（opencode）的 session 不随 run 结束自行终止，必须显式 abort。

**修复**：`_runCleanup()` 兜底调 `handle.abort()`（所有终态路径都经过它）。

**铁律来源**：opencode session 的生命周期是控制平面的职责，不能假设"run 结束 = session 结束"。

---

## 事故 2：06-18 GLM quota 耗尽（TD-37，更严重）

**发生了什么**：dispatch-readiness 测试套件的 `ledger.stop-aborted` 用例，派发 GLM coder + prompt "do not finish until stopped"。`stop` 命令在 93ms 内"成功"返回（HTTP 204 + transcript 写 `run.aborted` + 测试 PASS），**但 serve 端 session 持续运行 7.4 小时**，烧光用户半周 quota（智谱 coding plan max，约 1.25 亿 token）。

**根因**：`stop` 的 abort HTTP 调用返回成功 ≠ serve 端 session 真的停了。所有本地证据（seq 单调、state=aborted、HTTP 200）都正确，唯独最关键的事实（后台是否真停）从未被验证。这就是"基于意图的停止给出虚假成功"。

**关键证据**（opencode.db）：
- `ses_1280cd47afferI5Y6S1dZ5wfu4`：23:38 创建，abort 在 23:38:20 "成功"，但 `time_updated` 停在次日 07:00（被用户 taskkill 才停）
- 两个失控 session 后台 input 合计 ~86 万逻辑 token，按 provider 计费口径烧光半周 quota

**修复**：
1. **TD-37**：新增 `verifyStopQuiet`——stop 后轮询 3 轮 token/message，未停则强制 taskkill + 告警
2. **S1-1 token 闸门**：run 累计 token × multiplier 超 budget 即 failed + abort（唯一不依赖 stop 生效的防线）
3. **S1-3 告警**：budget_exceeded / stop_unverified → msg.exe 弹窗 + ALERTS.log

**铁律来源**：
- "成功停止"必须由实测定义（token 不再增长），不能由"调用没报错"定义
- 任何模型（含 GLM）在特定 task+context 下都可能无限运行，不能假设"某模型会自然停止"
- 06-17 复盘曾据此判定"GLM 无害"，导致 06-18 对 GLM 零设防——**这个错误结论已废弃**

**当前状态**：stop 路径已修（TD-37 ✅）；`_runCleanup` 终态路径的静默验证未做（TD-38 🟡，由 token 闸门兜底）。

---

## 为什么 opencode 比 claude-code/kimi-code 危险

| 维度 | opencode（HTTP） | claude-code / kimi-code（进程式） |
|---|---|---|
| 会话生命周期 | HTTP session，stop 可能虚假成功 | 进程死即会话死（OS 保证） |
| 失控后能停吗 | 靠 abort（可能失效）+ taskkill 兜底 | kill 进程即彻底停 |
| token 闸门 | ✅ 有效（有 session endpoint） | ❌ 无效（无 session endpoint） |
| 历史事故 | 06-17 + 06-18（两次） | 无 |

**权衡**：opencode 有 token 闸门但会话生命周期不可靠；进程式会话绝对可靠但无闸门。**默认走进程式（可靠停 > 有闸门但可能停不住）**，需要精确控成本时走 opencode（必配 tokenBudget）。

---

## 主控的责任（不是 worker 的）

worker 只看到任务 prompt，看不到这些安全约束。**主控负责**：
1. 派发前确认 worker 配了 tokenBudget（opencode）或用了进程式 backend
2. 监控 `runs/ALERTS.log`（budget_exceeded / stop_unverified）
3. 任务结束后确认无残留进程（`tasklist | grep opencode`）
4. 用 `.wao/` 记录状态，不依赖 session context
