# 决定 0051：run_consult 载荷合同——机械回执 + 按席分页（0039 修订）

- 日期：2026-10-09
- 状态：accepted
- 背景：TD-241 C3 实证（codex 0.159.2 大会审载荷 ~21KB/通道截断、original token count 10884；claude 2.1.289 成功面只见 structuredContent）；Owner 2026-10-09 点名三工作批（含缩载荷专窗）并授权按双席方案会审意见实施（consult_20261009140031757sdol5o，双席有条件放行，必改全录于规格与测试）。

## 裁定（载荷合同）

MCP `run_consult` 面（仅 MCP 面；CLI `consult show` 全量渲染不变）：

1. **create 成功 → 机械回执**（`view:"receipt"`）：consultId/recordPath/questions/brief/budgetMs/elapsedMs + 每席 {agentId, runId, runState, formatState, perspectiveSnippet?, budgetExpired, dispatchError?, laneGroup?, authorRelation?, modelRelation?, providerSessionRelation?, chars, pages, textFinal} + fieldDiff/fieldValues + bricks。**零正文、零摘要、零预览**（0039 ①：预览=有选择的截断）。剥离：finalText、attribution（正文第二份拷贝——会审补充靶点）、record 副本（回链锚点由回执 seats 自带 runId，持久记录在 recordPath）、每席 backend/provider（bricks.runtimeFacts 已携带，去重）。
2. **read 无 seat → 同一回执**（与 create 共用同一投影函数，不造第三种形状）。
3. **read {consultId, seat, page?} → 单页正文**（`view:"seatPage"`；page 默认 1）：页帽 **12KiB=整页响应（含外壳与转义）序列化后 UTF-8 字节**（非 JS 字符长度）；行边界优先切页，单行超帽按码点硬切（不拆代理对）；**各页按序拼接逐字节=席位最终文本**（无损，0051 的零截断兑现）；每页携带全文 `textSha256` 版本锚——跨页不一致=正文在读取间隙变化，从第 1 页重读（服务端无状态，不静默混拼的兑现=可检测）；`textFinal=false`（非终态席）标记分页边界会漂移。
4. **回执帽 6KiB**，成立边界（MRC-F1 钉）：≤5 席×≤32 字 id×≤128 字 snippet×≤10 问×≤120 字问句标题；正文体积完全无关。schema 上限（id 128 字/perspective 无帽/brief 派生问题无帽）超出此边界的病态输入可破帽——已知未收紧，防 creep 优先。
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

## 证据

- 测试：test/mcp-surface/mcpRunConsult.test.js 11/11（含中文密集多页/逃逸密集/代理对硬切/版本锚/拒绝面/容量边界）；m12-10 wire 28 项；kernel+consistency 243 项。
- 真实 dogfood：.dev/probe/consult-payload-smoke.mjs 对真实组记录 consult_20261009114921930gktuwk 走真服务器进程（npm run mcp）全 JSON-RPC——回执 1218B、拼回=独立转录真值逐字节、拒绝面正确（证据 .dev/evidence/0051-payload-smoke.json，ALL-PASS）。
