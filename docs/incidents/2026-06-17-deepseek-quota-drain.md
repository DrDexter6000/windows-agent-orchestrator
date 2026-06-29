# 事故复盘：DeepSeek-v4-flash quota 耗尽

> 日期：2026-06-17
> 严重度：高（用户当日 deepseek quota 完全耗尽）
> 根因：RunManager 终态路径不发送 serve session abort（控制平面 bug，非模型 bug）
> 状态：✅ 已止血 + 已修复 + 已测试 + 已记录

## 事件经过

M6 开发期间，为验证 first-stable 完成模式，启动了一次 `researcher`（deepseek-v4-flash）run。
该 run 投递 prompt 后 DeepSeek 在 serve 端无限多轮生成（模型已知行为），run 在 waitTimeout
后超时（state → timed_out）。但 **RunManager 超时路径只写了 `run.timed_out` 事件，
没有调用 `handle.abort()` 终止 serve 端 session**。DeepSeek 会话在后台持续生成，
数小时后彻底耗尽用户当日 deepseek quota。

用户从系统提示（opencode serve 日志）发现异常时，quota 已耗尽。

## 根因分析

opencode-serve 是 HTTP 类 backend：run 结束 ≠ serve session 结束。
进程式 backend（claude-code/codex）进程死了就是死了，无需额外清理；但 HTTP session
不会自行终止，必须显式 abort。

RunManager 有 5 条终态路径，清理都汇聚到 `_runCleanup()`：

| 路径 | 是否发送 serve session abort（修复前） |
|------|----------------------------------|
| completed（done completed） | ❌ 只写 run.completed |
| failed（done failed） | ❌ 只写 run.error + throw |
| **timed_out（超时）** | ❌ **只 controller.abort 打断本地轮询，serve session 活着（事故主因）** |
| user-abort（Run.abort） | ✅ 走 _abortInternal，调 handle.abort |
| scorecard 不通过 → failed | ❌ 同 failed 路径 |

即：除了显式 `stop <runId>`，所有"自然结束"路径都泄漏 serve session。
~~对会自然停止的模型（GLM-5.2，serve session 自己就停了）无害；~~
~~对 DeepSeek-v4-flash 这种无限多轮模型，就是 quota 黑洞。~~

> ⚠️ **上面这段"GLM 无害"结论【已废弃 / 2026-06-18 事故证伪】**（2026-06-23 取证修正）：
> 本次（06-17）窗口内 GLM session 量小，是因为被分配的任务简单（reply PING / 读文件），
> **不是因为 GLM 会自然停止**。同一 GLM-5.2 在 06-18 被 dispatch-readiness `ledger.stop-aborted`
> 用例派发"do not finish until stopped" prompt 后，后台失控运行 7.4h，烧光半周 quota。
> **正确结论**：任何模型（含 GLM）在特定 task+context 下都可能无限运行，调度安全不能建立在
> "某模型会自然停止"的假设上。详见 `docs/incidents/2026-06-18-glm-quota-drain.md`。

### 为什么 first-stable 没救场

first-stable 完成模式（opencodeServe.js）在判定完成后**确实**调了 abort，
但它只在"顺利走到 first-stable 完成分支"时才调。本次事故的 run 卡在超时——
从未进入 first-stable 的完成分支（DeepSeek 的 step-finish part 未在 waitTimeout 内出现），
于是走了超时路径，而超时路径不调 abort。

first-stable 的 abort 是**模型级缓解**（让无限模型能正常完成），
**不是会话生命周期管理**（那是 RunManager 的职责）。把会话 abort 寄托在某个
completionMode 的完成分支里，是职责错位。

## 止血

`taskkill /PID <opencode-serve> /F` 杀掉 serve 进程，连带断开 4 个 ESTABLISHED 的
zombie session。确认端口 4298 无 ESTABLISHED 连接。

## 修复

**单一控制点**：在 `_runCleanup()` 开头兜底调 `handle.abort()`（所有终态路径都经过它）。
这证明 WAO 会发送 abort；opencode 后台是否已停止 streaming/token 增长需要后续 `backendStopQuiet` 验证（TD-37）。
幂等保护：`_sessionKilled` flag，user-abort 路径（已通过 `_abortInternal` 调过）设此 flag，
`_runCleanup` 不重复调。进程式 backend 的 abort 是 no-op（进程已死），不报错。

```js
async _runCleanup() {
  if (!this._sessionKilled) {
    this._sessionKilled = true;
    try { await this.handle?.abort?.(); } catch { /* 兜底失败不影响终态 */ }
  }
  // ... 原 worktree cleanup ...
}
```

测试（红→绿，runManager.test.js）：
- completed 后 abortCalls === 1
- failed 后 abortCalls === 1
- timed_out 后 abortCalls === 1（事故主因路径）
- user-abort 路径不重复调（既有测试 + `_sessionKilled` flag）

`npm test` 245 pass / 0 fail（基线 242 + 3 事故修复测试）。

## 教训

1. **HTTP 类 backend 的会话生命周期是控制平面的职责，不是 completionMode 的职责**。
   "run 结束"在进程式和 HTTP 类 backend 语义不同——进程式进程死即结束，
   HTTP session 必须显式 kill。这个差异必须在 RunManager 统一处理（兜底 abort），
   不能依赖各个 completionMode 或各终态分支自己记得调。

2. **"本地流停了" ≠ "serve 端停了"**。controller.abort() 打断的是本地轮询循环，
   serve 端的 session 对此无感知，继续生成。超时路径用 controller.abort 是对的（停轮询），
   但还差一步——必须再调 handle.abort 让 serve 端也停。

3. **缓解措施本身要被当作可疑代码审计**。first-stable 加了 abort 就以为"DeepSeek 问题解决了"，
   但没审计超时/error 路径是否也覆盖。这是 milestone-discipline §6.3"逐文件审查"的又一印证：
   缓解措施只覆盖了它自己负责的那条路径，把会话生命周期管理也顺手塞进去是错误的耦合假设。

4. **无限多轮模型是真实的成本风险**。对这类模型，waitTimeout 不仅是"等多久放弃"，
   还是"最多让它烧多久 token"。first-stable（早完成早 kill）+ 短 waitTimeout + 终态兜底 abort，
   三者配合才能把 token 消耗限制在可控范围。

## 受影响配置

- `researcher`（deepseek/deepseek-v4-flash，completionMode: first-stable）—— 本次事故 agent
- 任何 opencode-serve backend + 无限多轮模型的组合
- claude-code/codex（进程式）不受影响（进程死即结束），但兜底 abort 对它们是 no-op，无害

## 相关

- 修复 commit：（本次）
- TD-35（docs/tech-debt.md）
- SKILL.md "opencode-serve operations & pitfalls" #4（已更新，标注 session kill guarantee）
