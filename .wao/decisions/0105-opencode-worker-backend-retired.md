# 0105 opencode worker 后端退役，代码与测试封存进 tag，专页入档

- 日期：2026-10-31
- 状态：accepted
- 来源：Owner 2026-10-31 原话："opencode我认为确实可以整体退役掉，因为"原汤化原食"（原厂harness驱动原厂llm）是我们这个项目的核心卖点之一。至于如何退役，我建议可以放入档案馆封存、不一定直接删除，未来再启用的时候也许可以去查阅"

## 背景

opencode-serve 是 WAO 的第一个 serve 型 worker 后端，06-17、06-18 两次 token 事故都出在它身上，TD-37/TD-38 的停止验证与 tokenBudget 硬门由此而来。此后车道迁往原厂 harness：到本决定时，现行 8 条车道没有一条用 opencode，serve 型后端只剩 kimi-web（与 opencode 只共用停止验证模块）。

## 决定

1. 从工作树删除 `src/backends/opencodeServe.js`、`scripts/serve.ps1`、只为它存在的角色合同运行时探测钩子（`validateRoleContractTransport`）与只测 opencode 的用例；停止验证模块 kimi-web 在用，改名 `serveStopVerify.js` 保留，契约不变。
2. annotated tag `archive/opencode-worker-backend` 指向 7fba310，即退役前最后一个含 opencode 后端的 main 提交。取回用 `git checkout archive/opencode-worker-backend -- <路径>`，测试一并取回，派发前重新认证。
3. `references/opencode-pitfalls.md` 原样移入 `docs/archive/`，在档案馆 README 登记。
4. OpenCode 作为 **MCP 宿主**的支持不变；决定、事故、changelog、调研里的 opencode 历史照原样保留。
5. 会话记录没有 `backend` 字段时不再默认按 opencode 停止：不发请求，路由文案用既有的 `unresolved`，停止事实的 backend 如实记 null。
6. 恢复（resume）一律重放：attach 分支只有 opencode 走得到，删除；声明不重放又带 `streamEvents` 的注入 backend 恢复时显式报错。
7. 所有 run 的取回（collect）从转录重建，serve 拉取路径删除；磁盘上旧的 opencode 转录同样这样读。
8. `wao registry check` 退役（它只探 opencode-serve）；`registry validate` 保留，删掉 opencode 专属字段检查。
9. 可靠性套件里只服务 opencode 的 stop drill、silentTimeout 探针、`--serve-url` 参数与缺省矩阵一并删除；矩阵行再写 `stop` 即显式失败（同 0084、0094 的退役 drill）。显式停止由 component-check 的 stop drill 覆盖。

## 被否方案

- 留作休眠后端：没有车道用，代码、测试、闭集、census、能力表与生成层都得带着它，纯成本。
- 挪进测试夹具当通用 serve 样例：测的是没人跑的后端；这类测试已先迁到 kimi-web（第 61a 批）。
- 直接删、不打 tag：Owner 要能查回。

## 已知局限

- 取回不是单文件即用：要连测试一起恢复并重新认证。
- 旧 opencode 运行只能读转录，不能再在线取消息。
- 无 backend 字段的旧会话记录不再发停止请求；这类会话若仍在跑，需人工确认已停。
