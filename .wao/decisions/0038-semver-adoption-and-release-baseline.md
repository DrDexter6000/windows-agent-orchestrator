# 0038: semver 采纳、v0.2.0 发版基线与 v1.0.0 门槛
status: accepted
date: 2026-10-01

## Context

v0.1.0 于 2026-08-16 打 tag（522b801，"first release tag"），此后 281 个提交、261 个文件、+66,419 行：新增 zcode 与 kimi-web 两个原厂 harness backend（backend 总数至 8）、六轴能力矩阵冻结与 `gen:certification` 生成面、delta 认证规程与上游原语复核 SOP（TD-184）、全部 8 个 worker 席位完成原厂 harness 迁移、卫生守卫首批落地（ADR 0035）。版本号单一来源已是仓库根 `package.json` 的 `version` 字段（MCP serverInfo 动态读取，server.js SERVER_VERSION）；但 CLI 无版本出口（`wao version` / `--version` 均不存在，安装面已登记缺口）。同时 TD-194（白天翻绿族）未关闭：全量 canonical 套件安静窗口（当地凌晨 01:00–06:00）首过率接近 100%，白天约 50%。

Owner 2026-10-01 决定：现在给 WAO 正式发布版本号；在 0.2.0 与 1.0.0 之间选择 0.2.0（1.0.0 是"稳定"的对外声称，一个只能在夜里验证全绿的系统，该声称的证据未到位）；并批准顺手补上 CLI 版本出口。

## Decision

1. **采纳 semver**。`MAJOR.MINOR.PATCH`：契约面（MCP wire 面、CLI 面、backend 契约）破坏性变更升 MAJOR，新增能力升 MINOR，修复升 PATCH。pre-1.0 阶段（0.x）允许 0.x 内不升 MAJOR 的契约调整（semver 对 0.x 的既定宽限），但 MCP tools/list 冻结面（m12-10 字节 SSOT）的任何变动仍走既有字节级守卫流程。
2. **发布 v0.2.0**（本次）。范围 = 上述 Context 列出的 v0.1.0 之后全部已合入 main 的变化；changelog 快照见 `docs/changelog-2026-10-01-v0.2.0.md`（过程类，时间冻结）。
3. **版本出口补齐**：新增 `wao version` 子命令与 `--version` 旗标（`src/version.js`，读 package.json 单一来源，输出裸 semver）。version 与 help 同类：豁免 Node 版本 guard，任何环境可查。
4. **v1.0.0 门槛 = TD-194 关闭**：全量 canonical 套件在白天（安静窗口之外）首过稳定。此为可验证线，不凭感觉定版。TD-194 关闭后下一次发版即为 1.0.0 候选。
5. **发版门槛沿 milestone-discipline §6.7**：打 tag 前全量 `npm test` 绿 + `npm run reliability`（真实 token）通过；白天全量遇已知翻绿族时按 TD-194 流程安静窗口复跑后再打 tag。

## Consequences

- 版本号的全部消费者（CLI `wao version`、MCP serverInfo）与 `docs/surface/*` 生成面均从 package.json 单一来源派生，发版 = 改一处 + 再生成 surface + tag，无第二处手写。
- tag 命名沿用 `vX.Y.Z`（annotated）并推远端（v0.1.0 先例）。
- 每次 MINOR/MAJOR 发版配一份 `docs/changelog-<date>-vX.Y.Z.md` 过程快照（范围汇总 + 证据指针），只追加不回改。
- 0.x 阶段白天套件波动不阻塞发版（由本决定第 5 条的复跑流程兜底），但阻塞 1.0.0（第 4 条）。
