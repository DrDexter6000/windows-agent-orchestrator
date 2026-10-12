# 0067 停滞收口的归属：没有生命体征才由控制面收口，有生命体征只建议（Lead 决定去留）

- 日期：2026-10-12
- 状态：accepted（Owner 2026-10-12 裁定，原话见"来源"）
- 来源：Owner 2026-10-12 的两条裁定（原话）——
  - 关于 codex 启动期死亡是否自动重试（TD-180）："我同意选 A，暂不做自动重试——记住，决策权在 lead agent 手里，我们只把必要的信息和知识告知 lead agent。"
  - 关于 glm-pro 的停滞门："如果 glm-pro 的任务进程没有任何生命体征（包括输出信息、输出动作、输出交付物，甚至 windows 进程活跃度/变化都可以视作生命体征），那么 5-10 分钟内收掉是合理的，但只要存在生命体征就不应该轻易放弃，而且如果要放弃也应该是 lead agent 来做决策而非 wao 自动杀死进程，wao 只做建议。"
- 关系：不变量 4（失败响应归 Lead）在停滞门上的落地；与 ADR-0030（等待窗到期 = 通知不杀）同向；取代同日 TD-197 的"续命静默满 120min 收口"硬顶；关 TD-265；落 TD-180 的 A 方案。
- 会审：送审中（kimi + sol 双席；结论与处置在合入前补入本节）

## 背景（2026-10-12 实测）

- **转录普查**（主检出 `runs/`，109 次 zcode 运行）：12 次被停滞门判 `turn stalled`。其中 7 次死时有工具调用在途（`npm test 2>&1 | tail -12`、等后台任务输出的 `TaskOutput` ×3、`git diff --stat …` 等），5 次死在模型长思考中。
- 同日上午加的流证词只覆盖后一类（模型在出 token）。工具命令在跑时模型不出 token、快照不长 part，流证词帮不上。
- 流证词自带硬顶（先是每 turn 累计 30min，当晚改为自上一个 part 起 120min）：流还活着也会被控制面收掉，与 Owner 的裁定相悖。
- `wao stop` 对 zcode 运行不生效（TD-265）：Lead 即便决定放弃也执行不了。
- **进程活跃度真机探针**（`run_202610121926214595bjyas`，glm-flash，依次跑 `sleep 40` 与 30s 忙循环；约每 6s 取一次 app-server 后代快照，后代 21–25 个进程）：

  | 阶段 | 后代 CPU | 后代 I/O | 进程生灭 |
  |---|---|---|---|
  | `sleep` 期间（空闲） | 0–2.5 ms/s | 4.2–8.7 KB/s | 无 |
  | 忙循环 | ≈990 ms/s | ≈4.6 KB/s | 无 |

  宿主进程自身因控制面每拍经 stdio 取快照而 I/O 恒涨，不能作证——只看后代。

## 决定

1. **收口归属**：控制面只在运行没有任何生命体征时自动收口；有生命体征的运行没有任何自动上限，去留由 Lead 决定，控制面只提供事实与建议。本决定先落在 zcode 后端。
2. **zcode 的生命体征**（任一成立即不收口）：
   - **进度**：快照落了新 part，或既有 tool part 原位落了新证据（工具调用的开始 / 结束）；
   - **流分片**：最近 60s 内收到过该会话的模型流分片；
   - **进程活动**：停滞预算击发且流不在收时，取一次 app-server 后代进程快照，30s 后再取一次——窗内后代 CPU ≥20 ms/s，或 I/O ≥64 KB/s，或有进程新生 / 退出。

   三项都没有 ⇒ 在自适应预算（300–600s）加 30s 观察窗处判停滞，错误文案写明取到的读数。零 part 阶段的两道门（silentTimeout / 120 拍思考预算）同样让位于流分片；流一停照旧收口。
3. **让 Lead 看得见**：流在收时每 60s 向转录发一条零载荷的 `runtime_activity("streaming")`（既有闭集；零新事件类型、零 wire 变更），等待类命令据此显示 `liveness=progress` / `lastActivityKind=runtime_status`。CLI `status` 在未终态且 ≥30 分钟没有新的动作或正文产出时附 `advisory` 一行（多久没产出、最近活动、中止命令；读时推导，转录零写入）。
4. **让 Lead 停得掉（关 TD-265）**：会话 id 是 provider 原生 id 的本机进程式后端在 spawn 结果里报 `hostPid`，RunManager 记入 `session.created`；stop 按会话记录的事实选路由（`proc_<pid>` 占位 id 或 `hostPid` → 进程树击杀并核验；`serveUrl` → 服务端中止），不按后端名分支。两者皆无时报错点名后端。
5. **TD-180 落 A**：不自动重试。`runs diagnose` 对"进程退出前零 worker 事件"的崩溃另列一条观察事实——只陈述事实，守诊断模块"给证据、不给处方"的铁律；既往案例与处置经验写进 `docs/troubleshooting.md` §7.15。
6. **不变**：MCP 工具面零触碰；没有新增转录事件类型；停滞预算本身（300s floor / ×3 / 600s ceiling）与 60s 新鲜度窗不变；进程活动取证只在"原本要收口"的那一刻发生（一次快照约 1s，不进常规轮询）。

## 诚实边界

- 流分片是上游内部遥测通道，形状只在 zcode CLI 0.16.9 实测过；上游改形状则识别不到，行为退回只看进度与进程活动。
- 进程活跃度阈值来自一次探针、一台机器、一组插件配置，不是长期统计。低 CPU 的等待型工具（`sleep`、等远端应答且无网络流量）在观察窗内读不出活动，仍会在预算处被收口——按 Owner 的口径这属于"没有生命体征"。
- 父子关系取自 `Win32_Process.ParentProcessId`，未做创建时间校验。快照不适用（非 Windows、宿主进程不在进程表里）时退回"没有这项证词"并立即收口；快照命令瞬时失败则下一拍重取，连续三次失败才按取不到收口。
- 进程证词续命期间转录没有新事件：等待类命令显示 `process_only`，Lead 看到的是"最近一次动作是那条命令、已过去多久"。没有为此新增事件类型。
- 有生命体征的运行不再有任何自动上限：没人看着的运行会一直跑到自己结束或生命体征消失，期间占着它的工作树。tokenBudget 对 zcode 兜不住（到完成阶段才上报 usage）。
- `hostPid` 只对本决定之后派发的运行存在；此前的 zcode 运行 stop 仍报无路由，需手动结束进程树。击杀前不校验该 pid 仍是原进程——与 `proc_<pid>` 路由同等风险（非终态运行的进程已死且 pid 被系统复用时会误杀）。

## 未做

- kimi-web 的 serve 证词硬顶（`LIVENESS_ATTESTED_SILENT_CAP_MS`，累计 30min）与本决定同类，未改——Owner 的裁定点名的是 glm-pro，是否一并适用待裁定。
- MCP 面没有 advisory 字段：MCP 上的 Lead 靠 `liveness` / `lastActivityKind` / `run_activity` 判断。让它直接看到 advisory 需要改 `run_status` 的输出形状并重冻结 wire，留作后续单独一批。
- 文档上限：`docs/troubleshooting.md` 原先离冻结字节上限只剩 1 字节，Owner 当日许可提升上限（"允许文档提升上限"），本批把该文档的帽由基线 +10% 提到 +20%；`docs/02-architecture.md`（剩 29 字节）与 `SKILL.md`（剩 16 字节）本批用不到，未动。
- "输出交付物"（工作树文件变化）没有单列为一项生命体征：文件写入要么经工具 part（已算进度），要么由子进程完成（已算进程活动）。

## 验证

真机（2026-10-12，glm-flash，本分支代码，独立 run 目录）：

| 运行 | 形态 | 结果 |
|---|---|---|
| `run_20261012194100803980vms` | 单条命令忙循环 400s（期间无新 part、无流分片） | 命令 22s 开始、434s 返回，运行 449s 正常完成——静默 412s，此前的停滞门在 300s 收掉 |
| `run_20261012194100790tw9abl` | 单条命令 `sleep 420` | 349s 收口：`no process activity in the last 31s (cpu +0ms, io +300B across 17 descendant process(es)) … no vital signs, bounded exit` |
| `run_20261012194100345do3udw` | `sleep 590` 在途时执行 `stop` | `stopped:true, backend:zcode, verified:true, outcome:killed`；转录落 `run.stop_requested` / `run.aborted` / `run.stop_verified`，状态 `aborted` |

三条运行的 `session.created` 都带 `hostPid`，模型出 token 的阶段转录里都有 `runtime_activity(streaming)`。

没有做的真机验证：长思考（流证词）路径没有在本分支上重跑——上午的 `run_20261012154649496i7i832` 是同一机制、硬顶删除之前的代码；CLI `status` 的 advisory 没有在真实的 30 分钟静默运行上观察过，只有单测。

测试结果见提交说明。
