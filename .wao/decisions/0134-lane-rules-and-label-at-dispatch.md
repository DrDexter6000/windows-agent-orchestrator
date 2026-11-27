# 0134 派发那一刻带 Owner 车道规则原文与此刻高峰；派发结果带 label

- 日期：2026-11-27
- 状态：accepted
- 来源：
  - Owner 2026-11-27 问"今天较多使用 sonnet 的原因"，说明是在诊断 WAO 的提示。Lead 查明：提示没错，但 Lead 走的路径看不到它。Owner："这个问题不能记入你的记忆或工作笔记就了事，确实应该结构性、工程化的来解决"。
  - Owner 又问：各出口带的是普适内容，还是硬编码？Lead 答：内容全部来自 `config/lane-traits.json`，代码只做投影和序列化。
  - 同一天 Owner 要求宿主的后台任务按"[车道] 任务名"命名，并且不为某一个 harness 专门优化（TD-384）。
  - 第 156 批：
    - 实现：glm-pro 首轮；修正一时 glm-pro 被限流，按车道规则换 deepseek-flash。
    - 方案会审：kimi、sol。
    - 交付会审：sol、deepseek-flash（consult_20261127184104444pjsiyl），第二轮 sol（consult_20261127195137190r4z0q3）。
- 关系：
  - 修订决定 0097 第 4 条中"Owner 规则只给指针"的部分。`laneFacts` 的形状不变，0097 否决"列出更便宜的替代车道"的理由照旧。
  - MCP 工具面重冻，记录见决定 0021。

## 背景

- 11-27 的第 154、155 批是写代码批次，Lead 在非高峰时段派给了 sonnet，理由写的是"按 /goal"。Owner 规则则是：较难的活在非高峰派 glm-pro 或 deepseek-flash；越过 glm-flash 时要写理由。
- 0097 的回显当时已经在，但有两个缺口：
  - CLI 只把它打到 stderr，`--format json` 的结果里没有。Lead 用 `grep` 筛 JSON，把它滤掉了。
  - 它只描述所选车道本身。Owner 规则只给一句"见 lead_preflight"，其他车道此刻是否高峰也看不到。

## 决定

1. **`label`。** 派发结果带 `[<车道>] <任务名>`，供宿主给后台任务命名。
   - 车道部分：本次实际派发的车道或 agent id；会审是席位别名，用 `+` 连起来。
   - 任务名：与 Owner 看板同源，用 `deriveOwnerTitle` 取，配同一个 `createSecretRedactor`。规则是取第一个非空行，跳过代码围栏，去掉 Markdown 标题记号，对环境里的秘密值做精确脱敏，再脱形状、清控制字符。
   - 整个 label 至多 80 个字符，按完整字符截断。取不到标题时，退回 runId 或 consultId。
   - 建议等待的那句 nextStep 末尾加"（后台任务可命名 <label>）"，放不下就只丢这句提示。
   - 不写任何宿主名或专有参数。
2. **`laneRules`。** 新增可选的结构化字段，只由 `buildLaneRules` 产出。
   - `rules`：`ownerRules` 全文，按原顺序，不过滤，也不截断。读不出、不合法或为空时，值为 `null`，并带固定的 `rulesReason`。
   - `now`：北京时间快照与 `holidaysRecognized: false`，加上 `peaks`：
     - 一个额度池里，全部成员都声明了高峰且声明相同，才合并成一行 `{pool, lanes, peakNow}`；
     - 否则对声明了高峰的车道逐条列出 `{lane, peakNow}`；
     - 行序与车道表一致。
   - 这条推导写在 `laneProfile.js` 的投影（`poolPeaks`）里。`lead_preflight` 不带它，因为它的 `rows` 已经有 `quotaPool` 和 `peakNow`。
3. **出口。**

   | 出口 | `label` | `laneRules` |
   |---|---|---|
   | CLI `run` | 后台 JSON 与文本行 | stderr 规则块（派发前，与 `[wao]` 行同一时点，先于暂停说明与所选车道事实）；前后台 JSON |
   | MCP `run_dispatch` | 受理回执 | 受理回执 |
   | `consult run` / MCP `run_consult` | 结果与回执；随组记录持久，读取模式回放 | 开始时的 advisory 规则块，每席另有一行所选车道事实；创建回执 |
   | CLI `runs continue` / MCP `run_continue` | 受理结果 | 不带：车道随谱系固定 |

4. **单一来源。**
   - 内容只从 `config/lane-traits.json` 经 `projectLaneProfiles` 取得，代码里没有车道名、时段或规则文字。
   - 一个构造函数、一个 stderr 渲染函数，各出口只做序列化。
   - WAO 自己的固定措辞各定义一次，节假日那句与 `wao lanes` 共用一个常量。
   - 依赖边由 `test/registry-roles/laneTraits.test.js` 钉住；测试一律用夹具规则。Owner 改规则，既不用改代码，也不会让测试变红。
5. **出错只降级本字段。**
   - 构造时抛错或值越界，`laneRules` 换成降级形，`label` 省略，命名提示随之不加。
   - MCP 回执先按字段 schema 严格校验，再整份组装。已受理的派发与会审，回执里始终有 runId 或 consultId。
6. **会审回执守 8 KiB。**
   - `projectConsultReceipt` 用帽合同的同一种序列化测量，只在这一处裁决：放得下才带完整规则。
   - 放不下就换成 `{rules: null, rulesReason: "回执容量不足，规则原文见 lead_preflight 的 lanes.ownerRules", now: null}`。
   - 不抬帽，也不截断规则原文。
7. **只告知。** 规则原文照录；WAO 自己不排序、不推荐、不拦截（不变量 4）。

## 否决的备选

- **派发前拦截，或要求写明理由**：选择权在 Lead（不变量 4）。0097 否决的那种确定性推荐器读不懂"只做会审"一类规则，拦截也读不懂。
- **把规则塞进 `laneFacts` 字符串**：会改变它的形状和长度上限，宿主也没法按字段读取。
- **只给与本次场景相关的那条规则**：等于由 WAO 判断"这次适用哪条"，属于语义判断。
- **记进 Lead 的记忆或工作笔记**：Owner 否决。别的 Lead 看不到，也没法测试。

## 已知边界

- 这些事实在受理之后才到：Lead 看到时运行已经开始，可以停掉重派。这里不设门。
- 不识别法定节假日。
- 规则条数或长度接近配置上限、再遇上大回执时，会审回执只带具名降级，不带原文；按现有规模带的是完整原文。
- 会审回执的 8 KiB 文档帽，在合同边界的最坏情形下仍会略超，第二轮实测 8,535 B。
  - 最坏情形：5 席、每席 32 字的 id、10 问、120 字标题、每问都声明字段。
  - 原因：字段键按问重复整段席位 id。即使不带 `laneRules`，也已经是 8,408 B，是 `label` 让它越过了线。
  - 宿主截断线约 21 KB，这里未收紧。
  - 同时出现时，"规则不可用"的原因会被换成"回执容量不足"。
- 读取模式的会审回执不带 `laneRules`，因为它是创建时点的快照。本批之前的组记录没有 `label`。
- 5 个长别名的席位会把标题挤没，label 只剩席位段。
- 车道超过 16 条时，`rows` 与 `poolPeaks` 各自截到 16 行，两边可能对不上；现有车道 10 条。
