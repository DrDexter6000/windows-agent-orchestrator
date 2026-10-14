# 0080 车道暂停派发说明：车道表的一个字段，各读取面现算

- 日期：2026-10-14
- 状态：accepted（Owner 批准做法，细节由 Lead 在 Owner 授权下确定）
- 来源：Owner 2026-10-14 的两段话。批准："我的偏向是同意和批准，前提是你也觉得从技术上、从构架上来看是合理的"。对初版交付的追问："这算不算又违反SSOT、管理膨胀？假设明天deepseek v4.1 pro更新了，而wao开发工作的lead agent不是你，我估计harness后端巡检之后又会忘记更新全部文件/文档"。
- 关系：决定 0064（车道画像读取面）、0067（停不停、派不派由 Lead 决定）、0076（一项事实一个归宿）、0078（MCP 工具面预算与重冻）。
- 合入授权：Owner 2026-10-12——"只要是你联合会审过的，我都许可 commit & push"。

## 背景

deepseek-pro 车道"调试中，暂勿派发"是 Owner 的指示，原先只写在车道画像 `config/lane-traits.json` 的自由文本里。`wao lanes` 看得到；MCP `registry_list`、CLI 派发和会审选席都看不到。

## 决定

1. **只有一个家。** 暂停说明是 `config/lanes.json` 车道的可选字段 `dispatchHold`，内容是 Owner 原话。
   - 形状由 `src/dispatchResolution.js` 的 `validDispatchHold` 校验，不合法整表拒载。
   - 它不是接线轴，派发解析不读它。
2. **读取面现算，不存副本。** 以下读取面都从这个字段现算：
   - `registry_list` / `registry list`，两者共用 inventory 服务；
   - `wao lanes`；
   - CLI `run` / `spawn` 与会审席位派发时，stderr 打一行 advisory。
3. **只提示，不拦截。** 派发照常进行，退出码不变，派不派由 Lead 决定。
4. **解除只改这一个字段。** `docs/certification-runbook.md`「harness 版本巡检」的检查单有一条【参】，提醒巡检之后判断是否解除。
5. **测试只用夹具车道表。** 测试不断言真实车道表里的暂停说明，解除暂停不会让任何测试变红。

## 否决的备选

- **只留在画像文本里。** 派发面和 MCP 看不到；画像是 Owner 的主观描述，不进派发面（0064）。
- **把原话写进 `run.started`。** 初版交付这样做过，被撤回：它是同一事实的第二份副本。某次派发时车道是否在暂停，可以由 `config/lanes.json` 的 git 历史和运行开始时间查到。
- **画像里也保留原话。** 那是第三份手工副本，解除暂停时最容易被忘掉。
- **拦截派发。** 违背"WAO 只告知，决定在 Lead"（0067）。

## 已知边界

- **MCP `run_dispatch` 的返回里没有暂停提示。** MCP 宿主上的 Lead 在派发前看 `registry_list`，SKILL 的派发前检查写了这一项。
- **CLI 给了非默认 `--registry` 时车道表停用。** 派发与会审不提示，`registry list` 的 `dispatchHold` 为 null；与 run 命令的防跨绑规则是同一条（`src/commands/shared.js` 的 `lanesDocForCall`）。
- **长度上限 200 字符。**
