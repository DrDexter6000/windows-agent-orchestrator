# 0114 续修接回原会话：谱系身份只取谱系自身的事实，车道+角色派发可续，续修轮的用量与缓存可量

- 日期：2026-11-05
- 状态：accepted
- 来源：Owner 2026-11-05："希望续修轮不仅仅原项目、原车道，更希望是原 session，因为原 session 才有可能集成上下文、利用 kv cache 降低 token 价格"；同日同意第 77 批（D 批）方案。Lead 侧使用评审的会审 consult_202611051157533033tik52（kimi、sol）。
- 关系：0112（窄缺陷交回原 worker 续修）；0045 §6 第 3 步（R3 裁定 H3 的具名拒绝在此收口）；TD-333。

## 背景

续修（`run_continue`）以 `turn:resume` 续父运行的 provider 原生对话。2026-11-05 核对到三处让它接不回原会话、或量不出接回的价值：

1. 谱系路由键与 opaque uuid 由"本次 MCP 服务的 Lead 会话"（每次启动随机生成）加 workspace、agentId、rootRunId 推导；首轮派发还带上车道指纹与角色正文 sha，续修不带。会话 id 记在转录里的车道（codex、kimi、zcode、deepseek-acp）从父转录取回 id，不受影响；按推导 uuid 续接的车道（claude-code）续修时算出的 uuid 与首轮不同，宿主重启后也一样，接不回原会话；按 Lead 会话分开的忙碌门在宿主重启后看不到重启前的续修。claude-code 还有第二处（2026-11-06 真实续修冒烟查到）：每次启动都给 CLI 一个新的隔离配置目录（`CLAUDE_CONFIG_DIR`，纯净模式），终态删除；CLI 把会话记录存在这个目录里，下一轮 `--resume` 同一 uuid 报 `No conversation found with session ID`，以 `error_during_execution` 失败。uuid 推导对了也接不回。
2. 车道+角色派发的父运行一律拒绝续修（`explicit_dispatch_continuable_unsupported`）：续修从 registry 席位重建子运行、不带角色，会静默换帽。
3. 每个运行只有一条 `run.metrics`。zcode 记的是会话累计数，续修子运行含前几轮（TD-333）；codex 不记缓存读取；没有逐请求用量，看不出续修轮的第一个请求是否命中缓存。

## 决定

1. **谱系身份只取谱系自身的事实**：workspace、canonical agentId、rootRunId，以及根运行派发时定下的车道指纹与角色正文 sha。首轮与每一轮续修用同一推导；不含 Lead 会话。宿主重启后续修仍接回原会话；忙碌门按谱系判定。专家复用（`lead_workspace`）不变，仍按 Lead 会话分开。claude-code 的复用与续修轮，用一个按 provider 会话定下的隔离配置目录（同一会话的各轮是同一个目录，终态不删，久不使用的由清扫删除）；纯净模式不变，目录里只有 CLI 自己的会话状态。
2. **车道+角色派发的运行可续**：子运行按父运行钉住的车道与角色重建，与显式派发同一解析；角色正文漂移、席位配置变化照旧拒绝。去掉 `explicit_dispatch_continuable_unsupported`。
3. **续修轮的用量可量**：
   - 后端声明自己的用量计量范围（本运行 / 会话累计），`run.metrics` 记下它。
   - `runs metrics` 给出每个运行自己的用量（会话累计的减去同一会话上一轮；上一轮读不到就如实写未知）、缓存占比（缓存读取 ÷（输入 + 缓存读取）），以及后端看得到逐请求用量时第一个请求的缓存占比；`--lineage` 列出整条谱系各轮。`runs metrics --summary` 按自身用量相加，TD-333 关闭。
   - 只记上游报出的数：上游报 0 就记 0，不报就缺，不推算。

## 已知边界

- 本决定之前建立的 claude-code 谱系，推导变了，续不回（此前已续不回）；会话 id 记在转录里的车道不受影响。
- claude-code 的会话目录只在长期令牌模式（`CLAUDE_CODE_OAUTH_TOKEN`）下建：拷贝凭据模式下长期保留的副本会与令牌轮换冲突（TD-229），复用与续修在启动前具名失败。
- 升级那一刻仍在跑的旧键续修，新的忙碌门看不到：对同一谱系再续修可能并发。窗口只在升级当时存在，升级前先等在跑的续修收口即可避开。
- 第一个请求的缓存只在后端看得到逐请求用量时有；只报每轮合计的后端缺这一项。
- 缓存能保留多久由 provider 决定；WAO 只记事实，不推断。zcode 至今报的缓存读取都是 0，WAO 照记。
