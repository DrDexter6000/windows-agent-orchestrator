# 0078 MCP 工具面的上下文预算、扩面前提与红线

- 日期：2026-10-14
- 状态：accepted。内容是 Owner 已批准的规则，原文只写在 roadmap 的一节里；roadmap 归档（`docs/archive/roadmap-2026-10-14.md`）时移到这里，数字按 2026-10-14 现状校正。
- 来源：Owner 2026-10-03 批准测量轮、试点与全量铺开（"①试点，先汇报不全量铺开"；"全量铺开+反复严谨测试+语义零损失"）；2026-08-15 三席评审定下的扩面前提；此后各次冻结线重冻与硬顶调整见决定 0032 修订节与 `test/mcp-surface/m12-10-tool-surface.test.js` 的冻结注释。

## 背景

- 宿主每个会话都要把工具描述读进上下文，不支持延迟加载工具的宿主每次都付全价（台账 TD-286）。
- 2026-10-03 实测（`scripts/measure-mcp-surface.mjs`，23 个工具的真实 stdio wire）：fullWire 84,528 B；hostVisible（name + description + inputSchema）21,854 B；description 11,837 B，占 hostVisible 的 54%；outputSchema 57,933 B，占 wire 的 68.6%，但不进 Codex 的投影。同日改写 12 个工具的描述后为 hostVisible 20,459 B、description 10,442 B、wire 83,133 B，roadmap 把这三个数记为"只降不升"的预算。
- 之后的批次在 Owner 批准下重冻过测试里的冻结线：description 10,442 → 10,976 → 11,391 → 11,408 B；2026-10-13 Owner "允许抬高 MCP 硬上限"，wire 硬顶定为 94,532 B，description 硬顶 12,347 B 不动，并追认了此前的重冻（决定 0032 修订节）。roadmap 里的三个预算数没有随之更新。
- 2026-10-14 现状：description 11,408 B（测试冻结线 11,408，硬顶 12,347）；wire 86,326 B（脚本口径；测试口径 86,292，冻结线 86,292，硬顶 94,532）；hostVisible 21,982 B，**没有测试守着**。

## 决定

1. **限额**：description 与 wire 以 `test/mcp-surface/m12-10-tool-surface.test.js` 的冻结线为准（防 creep：只在 Owner 批准的批次里重冻），上方是 Owner 定的硬顶（description 12,347 B、wire 94,532 B）；抬高硬顶由 Owner 决定。hostVisible 目前没有守卫：给它加上同样的冻结线并按下面的手段减量，是台账 TD-286 的工作。
2. **减量的手段**只比较两种：三句式紧凑 description；把少用的语义说明移到 response 或 resource。要求：23 个工具始终可调用；完整的 input schema 与 Lead 做决定所需的字段不丢；新宿主不预读文档也能正确首派，并能凭 response 自助恢复。
3. **红线**（不做）：lite/full profile、动态隐藏工具、通用 meta-tool、跨工具 `$defs` / `$ref`、先删 output schema、放宽枚举、控制面内嵌代码沙箱、自动化批量验收或重派。
4. **每次改 description 或 schema**：`npm run gen:surface` 再生成；评估 wire-cap 测试是否要重冻结；同步 `SKILL.md` 里的工具计数句。
5. **扩面前提**：工具数再增加之前，先做 per-tool 模块化（`src/mcp/tools/<tool>.js` 导出 `{name, schema, handler}`，薄 `server.js` 组装）。注册顺序由 `toolSurface.js` 的 `TOOLS` 数组驱动，不由模块 import 顺序决定；保留构造期的注册序列自检；拆分先过 surface-lock 字节稳定测试，再动结构。工具面的字节稳定分层与减面程序见决定 0021。

## 否决的备选

- **沿用 roadmap 的三个预算数**：description 与 wire 的冻结线已在 Owner 批准下抬过，再写那三个数会与测试和决定 0032 矛盾。
- **只留硬顶、不设冻结线**：硬顶比现值高约 8–9%，挡不住描述一批批变长。
- **零注入、内嵌代码沙箱一类方案**：2026-10-03 会审已否决（见红线）。

## 已知边界

- 第 23 个工具（`run_consult`）加入时，第 5 条的模块化前提没有执行；这条前提对下一次扩面仍然有效。
- token 数按 4.14 字节/token 估算；Claude Code 与 Kimi Code 的真实投影形状没有实测。
- 脚本口径与测试口径的 wire 数值略有差异（2026-10-14：86,326 B 对 86,292 B）。

## 修订（2026-10-14，TD-286）

hostVisible 也有了冻结线：`test/mcp-surface/m12-10-tool-surface.test.js` 的 `FROZEN_23_HOSTVISIBLE_CEILING`，口径同 `scripts/measure-mcp-surface.mjs`，按第 1 条只在 Owner 批准的批次里重冻。它没有单独的 Owner 硬顶：hostVisible 是 wire 的一部分，已在 wire 硬顶之内。
