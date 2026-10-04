# 2026-10-04：MCP 能力解析器镜像漂移误拒 continuable/correctable

> 类别：过程（事故复盘，时间冻结）。修复同日落地（见 §5 指针——一行，不维护进度）。

## 1. 经过

跨项目会话（E:\d2-domain workspace，2026-10-04 18:2x 本地）对 coder_mm（kimi-web）带
`continuable:true` + delivery 派发，连拒两次，MCP 报错只有塌缩后的
"run_dispatch failed"（零诊断）。`run_dispatch_contract_check` 判"合同有效"（其文档
声明范围不含后端资格——如实）。该会话 Lead 靠去掉 continuable 字段绕过并完成派发，
据此得出"continuable 与 kimi-web 后端不兼容"的错误结论（会污染后续路由决策）。

## 2. 根因

`src/mcp/server.js` 的 `resolveBackendFor` 是一份**手工五后端名单**
（opencode-serve/claude-code/codex/kimi-code/deepseek-harness），形似
`src/backends/factory.js`（认全 8 后端）的镜像但独立维护。kimi-web（第 7 后端，
2026-10-02 入列）、zcode（第 8）、deepseek-acp 不在表内 → resolver 返回 null →
`runDispatch` 能力门 `!continuationBackend` 误拒——尽管三者的后端类都白纸黑字声明
`supportsSessionReuse = true`（kimiWeb.js:177 / zcode.js:463 / deepSeekAcp.js:295），
kimi-web 还声明 `supportsInFlightCorrection = true`。

放大器（可诊断性缺陷）：两道能力门与 delivery-only 门都是无类型 `throw new Error`
→ MCP 边界 catch 塌缩成通用 "run_dispatch failed"，Lead 无从得知拒绝原因。

漂移能存活的原因：M12-7/M12-16 的既有测试全部用**注入的 fake backendFor** 打应用层
门，server 侧实际接线的 resolver **零测试覆盖**；factory.js 注释还把它列为"刻意不
并入"的独立构造点（当初理由是 null-vs-throw 语义，不是名单独立性）。

## 3. 受害面

- `continuable` 在 kimi-web / zcode / deepseek-acp 席位上必拒（误拒）；
- `correctable` 在 kimi-web 上误拒（其真正声明了在途纠偏能力）；
- `run_continue` 用同一 resolver（同病；其拒绝码 `unsupported_backend` 本身有闭集
  文案，根修后该路径对三后端自然打通）；
- 真正不支持续接的只有 deepseek-harness 与 opencode-serve（无声明=诚实拒绝）。

## 4. 教训

- 镜像名单=第二份真值。工厂注释"禁止并入"只保护了 null 语义的独立性，没意识到
  名单本身在漂——**语义例外要写成包装，不能写成抄本**。
- 无类型的拒绝=不存在的拒绝。能力门拒绝若塌缩成通用文案，等于把诊断成本转嫁给
  每个会话的 Lead（本次实际代价：两次重试 + 一个错误结论）。
- 测试要打接线，不只是打门。fake 注入测的是门的逻辑；真实 resolver 的覆盖
  （parity 钉）才防接线漂移。

## 5. 修复指针

同日落地（commit 见 blame 本文件）：resolver 改工厂薄包装（`KNOWN_BACKENDS` 闸
保 null fail-closed）；三门 typed + 固定原因码文案
（`continuable_delivery_only` / `continuable_backend_unsupported` /
`correctable_backend_unsupported`）；server 接缝 parity 钉 + 真工厂驱动腿 +
组合零副作用钉（`test/mcp-surface/mcpRunDispatch.test.js` /
`test/run-lifecycle/m12-7-runDispatchContinuable.test.js`）。方案会审：
`consult_20261004192559512mefa3k`（auditor run_20261004192559513jnxvxo，五点修正
全采纳）。无 TD 遗留。防再生：后端身份串消费面 census 守卫（test/isolation-infra/backendSwitchCensus.test.js，扩员同步面清单见 docs/certification-runbook.md §接入新模型/新运行时）——守卫落地当天另抓获 modelFamily 缺 kimi-web、registryInventory 硬编码列表两个同病实例（均已处置）。
