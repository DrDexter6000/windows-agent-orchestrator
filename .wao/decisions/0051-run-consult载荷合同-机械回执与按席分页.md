# 决定 0051：run_consult 载荷合同——机械回执 + 按席分页（0039 修订）

- 日期：2026-10-09
- 状态：accepted
- 背景：TD-241 C3 实证（codex 0.159.2 大会审载荷 ~21KB/通道截断、original token count 10884；claude 2.1.289 成功面只见 structuredContent）；Owner 2026-10-09 点名三工作批（含缩载荷专窗）并授权按双席方案会审意见实施（consult_20261009140031757sdol5o，双席有条件放行，必改全录于规格与测试）。

## 裁定（载荷合同）

MCP `run_consult` 面（仅 MCP 面；CLI `consult show` 全量渲染不变）：

1. **create 成功 → 机械回执**（`view:"receipt"`）：consultId/recordPath/questions/brief/budgetMs/elapsedMs + 每席 {agentId, runId, runState, formatState, perspectiveSnippet?, budgetExpired, dispatchError?, laneGroup?, authorRelation?, modelRelation?, providerSessionRelation?, chars, pages, textFinal} + fieldDiff/fieldValues + bricks。**零正文、零摘要、零预览**（0039 ①：预览=有选择的截断）。剥离：finalText、attribution（正文第二份拷贝——会审补充靶点）、record 副本（回链锚点由回执 seats 自带 runId，持久记录在 recordPath）、每席 backend/provider（bricks.runtimeFacts 已携带，去重）。
2. **read 无 seat → 同一回执**（与 create 共用同一投影函数，不造第三种形状）。
3. **read {consultId, seat, page?} → 单页正文**（`view:"seatPage"`；page 默认 1）：页帽 **12KiB=整页响应（含外壳与转义）序列化后 UTF-8 字节**（非 JS 字符长度）；行边界优先切页，单行超帽按码点硬切（不拆代理对）；**各页按序拼接逐字节=席位最终文本**（无损，0051 的零截断兑现）；每页携带全文 `textSha256` 版本锚——跨页不一致=正文在读取间隙变化，从第 1 页重读（服务端无状态，不静默混拼的兑现=可检测）；`textFinal=false`（非终态席）标记分页边界会漂移。
4. **回执帽 8KiB（验收批修订）**，成立边界（MRC-F1 诚实夹具钉：中文标题+在场字段值）：≤5 席×≤32 字 id×≤10 问×≤120 字中文标题×短字段值、**无视角原文**。初版 6KiB 被 sol 反例推翻（中文 120 字标题实测 7786B、字段值在场 6896B；旧夹具 ASCII 标题量出 4916B 属低估）；视角 snippet（真实记录全文 265-607 字/席，opus 实测 3 席回执即 87% 帽）自验收批起**整体出回执**（recordPath 取）。正文体积完全无关；schema 上限超界或字段值病态长可破帽——已知未收紧，防 creep 优先。
5. **拒绝面（固定文案，派发计数恒 0）**：create 模式带 seat/page；page 无 seat；席位不在组记录；席位无正文（附 runState/formatState）；页码越界（附 totalPages）。
6. **outputSchema 单一 strict 对象 + view 判别**（不用顶层 union——tools/list schema 序列化会重蹈 M9-2B-01）。
7. **不携带 availableDrilldowns**（维持六工具闭集）：分页指针由回执自带字段（consultId+seats[].pages）+工具描述承载；且 sol 条件"不得把可创建会审的裸 run_consult 加入通用观察目录"由不加入而平凡满足。
8. **成功面维持 text=JSON.stringify(structuredContent)**（两通道同缩，不引入通道不对称——C1 抽屉边界不变）。

## 0039 修订（不变式作用域澄清，非废止）

- 不变式①（零信息损失）：作用域=存储/渲染内核与 CLI 面（consult show 全量）。MCP 面的兑现方式=回执零正文+分页无损拼回+版本锚，**不是选择性预览**。
- 不变式②（标记即提示）：不适用域不变——fieldDiff/fieldValues/bricks 保留在回执（它们就是标记机制本身）。
- 不变式③（malformed 零重发）：不变。
- M13-r2"CLI 与 MCP 读取模式同形输出"合同**有意废止**：共享 rerender 内核不变，MCP 面加投影层。

## ADR 0021 程序（wire 收窄记录）

- 既有授权：0039（会审产品化）+ M13-r2 MCP 面 + TD-241 台账登记的缩载荷路线（"run_consult 摘要+档案号、细节 consult show 分页"）+ Owner 2026-10-09 三工作批点名。
- 本次收窄：MCP create/read 返回从全量对象改为回执；旧"只传 consultId"调用返回形状变化=**有意的破坏性变更**（参数可选≠向后兼容）。受影响消费者=经 MCP 面调 run_consult 的宿主（本仓 Lead 工作流走 CLI consult show，不受影响）。
- wire 重冻：SHA 8775b1bb…→188d36b2…；desc 顶 10442→10976（gen:surface 已再生成）。

## 附带修正

- SKILL.md（off-repo 操作员技能）`budgetMs: 0` 文档错误 → 实际入参 `waitMs`。
- TD-241 C1 抽屉重启条件①（"缩载荷路线落地后仍有可测 text 通道浪费"）的"落地"部分已满足；是否仍有浪费=后续探针可测（claude 成功面本就丢 text=零节省，剩余问题只在未探宿主）。

## 验收批修订（2026-10-09 同日，consult_20261009143257355gl404g 双席 PASS-with-fixes）

- M1：仓库 SKILL.md（经 0049 junction 与技能槽同体）补提交。
- M2：docs/usage.md §run_consult 按新合同重写（回执/分页/CLI 全量差异）。
- M3a：回执剥离 perspectiveSnippet（opus 方案 a）；帽 6→8KiB；MRC-F1 夹具改中文标题+在场字段值。
- 分页器二分改**码点边界搜索**（sol 实反例：逐位前缀测度在代理对边界非单调——落单高位代理 JSON 转义 6 字节 > 完整代理对 4 字节，三个 rocket、cap=6 时误抛"装不下"；反例已入 MRC-G1）。
- 占位上界 9999 → `text.length`（sol：每页至少一个 UTF-16 码元 ⇒ totalPages ≤ pages ≤ text.length、合法 page ≤ totalPages——占位成为已证明上界）。
- S1（opus）：sha/终态每席缓存；S2：行边界回退不浪费候选一半。
- M4：真实**多页**记录 dogfood（consult_20261008132958144con470：glm-pro 席 12284 字=2 页、astra 8848 字=2 页，拼回逐字节=独立转录真值）——证据 .dev/evidence/0051-payload-smoke-*.json。
- wire 二次重冻：SHA 188d36b2→d23f0ed1（schema 剥 snippet；描述字节未变，desc 顶 10976 不动）。
- S3（未做，挂账）：codex 0.159.2 宿主真读最大真实页（TD-241 C3 关闭前的宿主实证）——需非 WAO worker 的 MCP 客户端探针，另窗执行。

## 证据

- 测试：test/mcp-surface/mcpRunConsult.test.js 11/11（含中文密集多页/逃逸密集/代理对硬切/版本锚/拒绝面/容量边界）；m12-10 wire 28 项；kernel+consistency 243 项。
- 真实 dogfood：.dev/probe/consult-payload-smoke.mjs 对真实组记录 consult_20261009114921930gktuwk 走真服务器进程（npm run mcp）全 JSON-RPC——回执 1218B、拼回=独立转录真值逐字节、拒绝面正确（证据 .dev/evidence/0051-payload-smoke.json，ALL-PASS）。
