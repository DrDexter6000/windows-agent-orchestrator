# 终态原因分类对照：Symphony ↔ WAO

**日期**：2026-08-16
**类别**：调研归档（外部参考 + 裁定记录；非现行契约源——现行契约见 `docs/02-architecture.md` 事件表与 `src/transcript.js` SSOT）
**触发**：Round 4 Bundle A——`run.state_change` 的 `reason` 字符串冻结为闭集（`STATE_CHANGE_REASONS`）前，对照业界编排器的终态/原因分类学，裁定 WAO 是否需要 Stalled 终态与自动重试。

---

## 一、Symphony SPEC 摘录（源材料）

> 双席 2026-08-16 联网核验自 Symphony（OpenAI 开源 Codex 编排器）SPEC.md 原文：

- **§7.2 五终态**：`Succeeded / Failed / TimedOut / Stalled / CanceledByReconciliation`；原文理由："Distinct terminal reasons are important because retry logic and logs differ"。
- **§8.4**：失败自动指数退避重试（`delay = min(10000·2^(attempt-1), max_retry_backoff_ms)`，上限 5 分钟）。
- **§8.5**：stall 检测 = 距 `last_codex_timestamp` 超 `stall_timeout_ms`（默认 300s）→ 杀 worker 并自动排队 retry；`CanceledByReconciliation` → 抑制重试。
- **背景**：Symphony 是 issue-tracker 驱动、带自动重试与每 tick reconciliation 循环的编排服务。

Symphony 的立场可以一句话概括：**终态分类是为机械响应策略服务的**——不同终态触发不同重试策略，所以必须在控制面穷举区分。这个前提 WAO 有，但结论 WAO 刻意不采纳（见 §三裁定）。

---

## 二、Symphony 五终态 ↔ WAO 两层模型逐项映射

WAO 不用单一"终态枚举"承载原因：**第一层**是 4 个终态（`completed / failed / aborted / timed_out`，`TERMINAL_STATES`），**第二层**是 `run.state_change.reason` 冻结闭集（`STATE_CHANGE_REASONS`，28 成员）+ 15 类诊断分类（`DIAGNOSIS_CATEGORIES`，diagnosis.js）+ liveness 投影（runObservationProjection.js 的 observation/termination 二元组）。两层相乘的表达力严格覆盖 Symphony 的五终态，且把"发生了什么"（事实）与"该怎么办"（处方）分开。

| Symphony 终态 | WAO 对应物 | 映射说明 |
|---|---|---|
| `Succeeded` | `completed`（reason=`done`） | 一一对应。WAO 另以 `run.completed` fact + scorecard/delivery 证据链区分"真完成"与"自报完成"（scorecard_failed 门槛）。 |
| `Failed` | `failed` + reason 细分 + 15 类诊断 | Symphony 的 Failed 是一个桶；WAO 拆成 14 个 failed-域 reason（spawn_error / startup_error / delivery_parse_error / reuse_worktree_parse_error / certification_gate / fire_forget_guard / workdir_escape / budget_exceeded / scorecard_failed / delivery_failed / backend_error / backend_stream_ended / backend_unknown_reason / process_missing）+ 诊断分类（provider_auth / provider_capacity / crash / no_effect / ...）。同 Symphony 原文的动机——"logs differ"；但 WAO 的差异化发生在**诊断呈现层**，不发生在自动响应层。 |
| `TimedOut` | `timed_out`（reason=`timeout`） | 一一对应，且 WAO 更严格：TD-105/M12-11 语义修正后，`timed_out` **只能**由 wall-clock deadline timer 产生（run.timed_out durable fact）；backend 崩溃或流静默绝不伪装成超时（backend crash → failed/backend_*）。Symphony 无此区分的明文要求。 |
| `Stalled` | **刻意非终态**——liveness 投影（window_expired / no_effect 诊断）+ Lead 判停 | Symphony §8.5 由控制面判停并杀 worker。WAO 裁定相反：判停权归 Lead（TD-74/75 宁慢勿杀——杀一个仍在工作的 worker 的代价高于多等）；控制面只提供 liveness 事实（run_wait/run_await_result 的 observation outcome），诊断只给 no_effect/provider_disconnect 类别，**不设 Stalled 终态、不自动杀**。 |
| `CanceledByReconciliation` | `aborted`（reason=`stop_requested`/`external_signal`/`user`/`SIGINT`/`daemon_stop`/`ipc_stop`）+ `process_missing` 结算 | Symphony 的 reconciliation 循环每 tick 对账并取消失联 worker。WAO 的对应物分两支：(a) 显式 stop 仲裁——runStop 经 first-terminal-wins claim `aborted`，6 个 abort-域 reason 记录**谁**中止（Lead stop / 外部信号 / 用户 / SIGINT / daemon 关闭 / IPC stop）；(b) 孤儿结算—— detached runner 进程可证死亡时，由 Lead 显式授权 run_delivery_repackage 以 reason=`process_missing` 结算为 failed（M12-19，附 run.process_missing_confirmed fact），是 Lead 授权的一次性动作，不是每 tick 自动对账。 |

---

## 三、裁定记录（本归档的核心结论）

1. **不引入 Stalled 终态。** Stalled 在 Symphony 里的全部用途是触发"杀 worker + 自动重试"；WAO 拆掉这个触发器后，Stalled 作为终态没有独立语义——判停是语义判断，归 Lead（TD-74/75 宁慢勿杀；不变量：控制面确定性）。liveness 投影已提供判停所需的全部机械事实。
2. **不引入自动重试（§8.4 对应物不建）。** ADR 0018（机械遏制，不自动监督）+ AGENTS.md 不变量 #4："The control plane stays deterministic. Semantic decomposition, failure response, and final acceptance belong to the Lead."——failure response 明文归 Lead。控制面自动重试一个语义未知的失败 run，等于替 Lead 做语义判断（何为"值得重试的环境性失败"）。
3. **差异化机械响应的对应物 = Lead 的 SKILL/playbook 层，不是控制面。** Symphony "retry logic and logs differ" 的诉求在 WAO 由两层承接：logs differ → 控制面的 reason 冻结闭集 + 诊断分类（本 bundle 补齐 SSOT）；retry logic differ → Lead 读诊断后按 SKILL/playbook 的 playbook 决策（Lead 驱动 run_retry/重新 dispatch）。机械的归控制面，策略的归 Lead。

## 四、治理注记（STATE_CHANGE_REASONS 的冻结纪律）

- `STATE_CHANGE_REASONS` 是 `run.state_change.reason` 的**写入侧冻结闭集**（SSOT = `src/transcript.js`，`Object.freeze`；守卫 = `test/isolation-infra/stateChangeReasons.test.js`，deepEqual 钉成员 + 关系型断言）。写入侧生产者一律引用 `STATE_CHANGE_REASON.<member>`，不得自带字面量。
- **读侧不校验**：历史 transcript 的遗产值（如 start/init）与测试合成值合法存续，不入集；诊断/投影按"命中闭集成员才归类，否则 unknown"消费。
- 事件类型消歧：`replay`（run.rerun payload）、`first_terminal_wins`（run.state_change_rejected payload）、`run.aborted` 的 `payload.reason` 是**其它事件的事实字段**，不属本闭集（run.aborted 的 payload.reason 与同批 state_change reason 同值，经转移调用点枚举，不重复入集）。
- 同域既有冻结闭集不动：REVERIFY_REASONS / CORRECTION_REJECTION_REASONS 等独立域闭集与本闭集分属不同事件契约，不合并。
