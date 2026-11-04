# 0112 评审出的窄缺陷交回原 worker 续修，WAO 在交付收口时提示

- 日期：2026-11-04
- 状态：accepted
- 来源：Owner 2026-11-04："continuable和run_continue是我非常看重的能力……我不认为这是lead agent的问题，我把它看作wao的引导和提示不足的问题，应予解决"；同日预先授权 SKILL.md 按需扩限。方案会审 consult_2026110416480107605yuyn（sol、deepseek-flash 均 FIX_FIRST，已吸收）。
- 关系：用 M12-7 的续谱（`continuable` + `run_continue`）；修订 0095 第 3 条（`nextStep` 出现位置）。

## 背景

- SKILL.md 只在工具清单里列了 `run_continue`，没说何时用；`docs/usage/delivery.md` 的验收一节也没提。本仓 11-01 以来派了 17 个可续交付，09-29 以后没有续跑过一次：评审出的问题由 Lead 手改，或先采纳再修，父交付一采纳就续不了（`parent_accepted`）。宿主项目 10-29、10-30 续跑了 18 次。
- 续跑那一轮通常便宜得多：09 月 codex 车道几组，新开一轮输入 18–27 万 token、续跑 1–9 万；glm-pro 的 `run.metrics` 是会话累计数，按相邻两轮的差值算每轮续跑约 3–5 万，新开 15–40 万。
- 统计口径：运行转录里 `run.session_reuse`（`mode: run_lineage`）的 `turn: first` 计可续交付、`turn: resume` 计续跑，按事件日期与项目桶分；token 取各运行最后一条 `run.metrics` 的 `tokens.input`。

## 决定

1. SKILL.md 验收一节加一步：带 `continuable` 派发的运行，评审发现的窄缺陷，裁定前用 `run_continue` 交回原 worker，再审、裁定子交付；`run_continue` 的拒绝是闭集、零副作用；先采纳就续不了；Lead 只手改措辞。派发一节写明交付按 `agentId`、能续的后端带 `continuable: true`。SKILL.md 上限按 Owner 授权上调（数值以 docs-consistency 守卫为准）。
2. 交付收口、未采纳（未决定或已拒收），且这次运行是带 `continuable` 派发的谱系成员（不是 explicit 车道加角色派发，所在线系未闭合）时，MCP `run_delivery` 带 waitMs 的收口返回与 CLI `runs wait --until-settled` 的收口终行给一句 `nextStep`：这次是带 continuable 派的，窄缺陷可用 `run_continue` 交回同一个 worker 会话，它在动手前先查资格；已采纳的交付不能再续。
   - 只陈述可以从转录查实的事实，不断言 `run_continue` 一定受理：角色正文漂移、registry 或后端变了、会话证据不足、工作树没了，都要到 `run_continue` 自己的资格检查才知道，那里的拒绝零副作用、带闭集原因。
   - 谱系判定与 `run_continue` 资格检查第 5 步共用一个函数，`continueRun` 的拒绝顺序不变。
   - 不建议采纳或拒绝，不自动续。
3. `continuable` 默认值不变；review bundle（嵌 BASE）、即时查询、工具描述不变。

## 否决的备选

- 默认 `continuable: true`：派发侧不是瓶颈（Lead 已常带），默认值还要随后端能力变，Lead 从参数上读不出这次能不能续。
- 提示前先跑一遍完整资格检查：要读 registry、角色文件、做 Git 证明，每次查询都付这份成本；而 Lead 直接调 `run_continue`，被拒也只是零副作用的闭集结果。
- 自动续修：WAO 不推断续跑（M12-7），语义处置归 Lead（不变量 4）。

## 已知边界

- review bundle 与 `runs delivery` 即时查询看不到这句提示，靠 SKILL.md 那一步。
- 打包失败的父运行 `run_continue` 也可能受理，这里不提示；那是另一条处置路径。
