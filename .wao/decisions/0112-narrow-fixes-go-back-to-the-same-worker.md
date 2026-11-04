# 0112 评审出的窄缺陷交回原 worker 续修，WAO 在交付可审时提示

- 日期：2026-11-04
- 状态：accepted
- 来源：Owner 2026-11-04："continuable和run_continue是我非常看重的能力……我不认为这是lead agent的问题，我把它看作wao的引导和提示不足的问题，应予解决"；同日预先授权 SKILL.md 按需扩限。
- 关系：用 M12-7 的续谱（`continuable` + `run_continue`）；`nextStep` 的家是 0095，本决定加一种情形。

## 背景

- SKILL.md 只在工具清单里列了 `run_continue`，没说何时用；`docs/usage/delivery.md` 的验收一节也没提。本仓 11-01 以来派了 17 个可续交付，09-29 以后却没有续跑过一次：评审出的问题由 Lead 手改，或先采纳再修，父交付一采纳就续不了（`parent_accepted`）。宿主项目 10-29、10-30 续跑了 18 次。
- 续跑那一轮便宜得多：09 月 codex 车道几组，新开一轮输入 18–27 万 token、续跑 1–9 万；glm-pro 的 `run.metrics` 是会话累计数，按差值每轮续跑约 3–5 万，新开 15–40 万。

## 决定

1. SKILL.md 验收一节加一步：评审发现的窄缺陷，裁定前用 `run_continue` 交回原 worker，再审、裁定子交付；先采纳就续不了；Lead 只手改措辞。派发一节写明交付按 `agentId` 派、能续的后端带 `continuable: true`。上限 13800→14400。
2. 交付已可审、未采纳、且这次运行是可续谱系成员时，WAO 收口时的 `nextStep` 说一句：窄缺陷可用 `run_continue` 交回原 worker，先采纳就续不了。判定与 `run_continue` 资格检查里的静态事实共用一处。只陈述可续这一事实，不建议采纳或拒绝，不自动续。
3. `continuable` 默认值不变。

## 否决的备选

- 默认 `continuable: true`：派发侧不是瓶颈（Lead 已常带），默认值还要随后端能力变，Lead 从参数上读不出这次能不能续。
- 自动续修：WAO 不推断续跑（M12-7），语义处置归 Lead（不变量 4）。
