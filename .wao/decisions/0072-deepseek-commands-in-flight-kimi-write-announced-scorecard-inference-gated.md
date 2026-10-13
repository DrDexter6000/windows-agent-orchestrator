# 0072 deepseek 车道的命令在途可见；kimi 写文件在途预告；评分的退出码推断按后端声明门控

- 日期：2026-10-13
- 状态：accepted（Owner 2026-10-13 裁定，原话见"来源"）
- 来源：Owner 2026-10-13 对决定 0071 收尾报告的回复（原话）——"1、写文件在途仍不可见 —— 下钻的工具run_activity可以看到worker agent的最新动态吧？ 2、claude code已重启 3、deepseek的车道也把"命令在跑时 Lead 看不看得到"做了 4、同意修评分逻辑的退出码推断"。
- 关系：决定 0069 / 0070 / 0071（Lead 中止前先看 worker 在做什么；codex、kimi 的命令在途可见）在 deepseek 车道上的同一件事；ADR-0032 §8 的 `reportsCommandExitCode` 声明；不变量 3（后端差异留在 Backend 内，共享代码读能力声明、不按后端名分支）。
- 会审：见文末"会审"。
- 合入授权：Owner 2026-10-12——"只要是你联合会审过的，我都许可 commit & push"。

## 背景

### deepseek 车道：命令要到结束才出现，原因有两层

读代码能看到第一层：`deepSeekAcp.js` 收到 shell 类的 `tool_call` 只把命令记进待确认表，等终态的 `tool_call_update` 才落 `command`。

只修这一层不够。改完后真机跑（deepseek-flash，先写一个文件再 `sleep 40`），在途的那一条仍然和命令结果落在同一秒。加临时探针记协议帧的到达时刻（只记类型与键名，已撤）：

| 时刻（UTC） | 帧 |
|---|---|
| 08:35:22.867 | `tool_call`，`title:"pwsh"`，`status:"in_progress"`，`rawInput` 带 `command` |
| 08:36:04.169 | `tool_call_update`，`status:"completed"` |

调用通知在命令开始时就到了，是 WAO 自己把它压住了——第二层在事件队列：`_events` 把一批事件逐条 `yield` 给消费方，消费方处理上一条（落转录）期间到达的事件进了队列，但此刻没有等待者可唤醒；这一批 `yield` 完之后，循环只在"队列已关闭"时才回头看队列，否则直接去等下一次推送。于是这条事件滞留到下一次推送才放出来——长命令期间，下一次推送就是命令结束。调用通知紧跟在思考分片之后到达，正好落进这个窗口。`deepSeekHarness.js` 是同一段写法。

这不只影响命令：任何"到达时消费方正忙、之后又长时间没有新事件"的事件都会晚落，例如长工具调用的 `tool_use` / `write_intent`。

### kimi 车道：写文件调用在途看不到

决定 0071 让命令与工具调用在轮询期落盘，但写文件类的帧在途整个跳过，理由是 `file_written` 只能在这一轮带着正文完成时落。那条理由护的是写文件**证据**，护不到"Lead 不该知道 worker 正在写哪个文件"。

### 评分：没有退出码的命令被推成"通过"

`scorecard.js` 对没有数值退出码的命令，按 `toolCallId` 找到它的 tool_result，成功记 0、失败记 1。`run_activity` 自 TD-220 起只对证明过的后端这样做，评分逻辑没有任何门控（决定 0071 会审时 sol 指出）。真实转录（983 个）里的结果：

| 后端 | 声明能产出退出码证据 | 命令数 | 自带数值退出码 | 被推成 0 | 被推成 1 |
|---|---|---|---|---|---|
| codex | 是 | 4179 | 4179 | — | — |
| claude-code | 是 | 6968 | 0 | 6658 | 306 |
| kimi-code | 是（依据不成立，见决定第 4 条） | 729 | 0 | 518 | 211 |
| zcode | 否 | 1337 | 0 | **1335** | **0** |
| kimi-web | 否 | 865 | 0 | 842 | 22 |
| deepseek-acp | 否 | 93 | 0 | 0（关联键是工具名，推断本来就接不上） | 0 |

zcode 上这条推断从没推出过一次失败：`requireCommands` 在 glm 车道上只验了"命令跑过"，没有验"命令通过"。历史上靠它通过的评分共 18 次（zcode 12、kimi-web 6），全部是认证演练（`scripts/reliability-tmp`，2026-10-01 至 10-06），没有 Lead 的实际任务。

## 决定

1. **deepseek-acp 正常关联的 shell 调用到达即落一条 `tool_use`**（带命令原文；缺失 / 重复 `toolCallId` 的调用照旧走原有的降级路径）。`command` 证据仍在终态落（那时才可能有退出码），命令条数不变。codex 自决定 0070 起是同一形状。
2. **修掉两个 deepseek 后端事件队列的丢唤醒**：等下一次推送之前先看队列里有没有东西。只改时机，不改内容与顺序。
3. **kimi-web 的写文件帧在途预告**：输入里出现路径后落一条 `tool_use`，输入只带 `path`（不带文件内容）。不落 `file_written`、不落结果——写文件证据仍只在这一轮带着正文完成时落，失败的轮、没有正文的 completed 轮照旧不落（N1 不变）。没有身份（`toolCallId` / `frameId`）的帧照决定 0071 的规则在途跳过。
4. **评分的退出码推断按后端声明门控**：`checkScorecard` 新增 `inferCommandExitCode`，默认关；`RunManager` 按 backend 类的 `reportsCommandExitCode === true` 传入。这条声明的含义本来就是"WAO 今天能否为这个后端产出命令退出码证据（含这条推断通道）"，认证层一直按它判，产品侧的评分此前没有跟上。
   - 声明为否的后端（zcode / kimi-web / deepseek-acp）上，命令事件不带数值退出码时 `requireCommands` 通不过。实测这三个后端的命令事件都不带（上表）；deepseek-acp 留有一条从输出文本里提取 `exit code: N` 的通道，提取到数值时照数值判，真实转录里一次没有提取到过。检查的 `detail` 保留原有的 `exitCode=undefined` 形状（认证脚本靠它区分"证据不可得"与"观察到非零退出"），并追加一句限定到这些命令的原因与出口：改用 `requireAcceptance`（独立脚本验收），或把 `mode` 设为 `"warn"`。
   - `wao registry validate` 对"agent 配了 `scorecard.rules.requireCommands`、后端不产出退出码证据"给出 ⚠（与 tokenBudget、sessionReuse 的同类提示并列）。
   - **声明是门，不是证明。**这一条修的是"未声明的后端也被推断"；它没有让声明为是的后端上的推断变得可靠。会审（sol）指出：kimi-code 的 `isError` 是 `parsers/kimiCode.js` 对输出文本做的关键词匹配（`/error|failed/i`），不等于退出码——构造反例里输出 `Process exited with code 7` 被推成退出码 0、评分通过，输出 `0 failed; no errors` 被推成失败；实地数据里它 29% 的命令被推成失败，也与关键词误伤相符。deepseek-harness 的 `isError` 取自结果帧的 `error` 字段，比关键词直接，但没有"非零退出必然置 error"的证据。这两个后端的声明在 main 上就是 true，本批没有动：翻成 false 会让它们的严格认证轴变成 N/A（按现行纪律即 draft-only），属于 Owner 的决定。逐条证明过的只有 claude-code。
   - 认证脚本的角色合同探针（`componentDrills.mjs`）此前无条件带 `requireCommands`；门控生效后它会让 zcode / kimi-web 的探针 run 被评分门判 failed，角色合同那一格随之变成"未评估"。改为只对声明为是的后端带这条规则。

## 行为变化与如实边界

- **deepseek-acp 的转录每条 shell 命令多一条 `tool_use`**。`run_activity` 在命令结束后会同时列出这条 `tool_use` 与 `command`（codex 相同）。证据条数、活动条数相应增加。
- **两个 deepseek 后端的事件落盘时机提前**：此前滞留的事件现在不再等下一次推送（仍排在消费方处理完上一条之后）。历史转录里这类事件的时间戳晚于实际发生时刻。中止发生时，转录里会多出中止之前已经到达、此前会被压住的活动。
- **新增的 `tool_use` 是普通活动事实**：`requireEvidence` 本来就接受工具调用，deepseek-acp 上现在一次到达的 shell 调用就能满足它（它从来不证明命令通过），只有这一条调用就自报完成的运行也不再带 `completed_empty` 标记（协议正常时回合结束在工具终态之后，这种形状基本只在构造里出现）；这些事件也计入诊断里按事件数判断的门槛（如 `provider_disconnect` 的最少事件数）。
- **失败的 deepseek-acp 运行里会留下在途的 `tool_use`**。在 shell 调用到达与结束之间失败的运行，此前转录里没有这次调用的任何痕迹；现在有一条 `tool_use`，满足诊断"有活动无产出"（`no_effect`）的活动条件，这类运行的诊断可能从 `crash` 变为 `no_effect`（codex、kimi-web 在决定 0070 / 0071 之后同理）。
- **kimi 的预告只说"调用了写文件工具、目标是哪个路径"**，不是文件已写入的证据；失败的轮里留下预告而没有 `file_written`，不代表磁盘上没有写。只在最后一拍才看到的轮没有预告，转录与此前相同。输入就绪后路径若被改写，预告的是当时看到的那一版。
- **`requireCommands` 在 glm / kimi 车道上从"跑过就通过"变为"通不过"**（deepseek-acp 一直通不过——它的推断本来就接不上）。gate 模式下运行会转 failed。这是修正：此前 zcode 上的通过只说明命令跑过，kimi-web 上的通过把"工具结束"当成了退出码 0。
- **认证层的判定不变**：声明为否的后端上 `commandsPassed` 仍记 N/A（不置绿、不算失败）。变化在演练 run 自身的状态——zcode / kimi-web 上带 `requireCommands` 的演练 run（严格评分演练、隔离演练）此后以 failed 收尾（deepseek-acp 一直如此）；它们的消费方读的是具体检查项与工作树 / 文件事实，不读这个 run 的完成状态（会审按代码链路核过）。认证演练消耗 token，本批没有重跑。
- **`run_activity` 的推断门没有并轨**：它仍用 `scorecard.js` 里"逐条证明过"的闭集（只有 claude-code）。kimi-code、deepseek-harness 声明为是，评分会推断，活动投影不会。
- **deepseek-harness 的丢唤醒修复只有单元测试**：本机没有注册走该后端的车道。
- **没做**：deepseek 两个后端仍没有接"转录静默后取样进程 / 文件体征"（决定 0070 的那项）。

## 验证

| 项 | 结果 |
|---|---|
| 评分门控：默认不推断；声明可信时照旧推断；自带数值退出码不受影响；`detail` 的形状让认证层读作"证据不可得"（`scorecard.test.js` 0072①②） | 通过 |
| `RunManager` 按 backend 声明传入：未声明的 backend 上"工具成功"不再让 `requireCommands` 通过，声明的照旧（`runManager.test.js` 0072） | 通过 |
| `registry validate` 的 ⚠（`backendCapabilityValidate.test.js` 0072）；探针规则按声明条件化（`componentCheck.test.js` 结构钉） | 通过 |
| deepseek-acp：调用到达落 `tool_use`、终态落 `command`、条数不变；从未到终态的调用只有在途那一条（`deepSeekAcp.test.js` ACP 0072） | 通过 |
| 丢唤醒：消费方挂在上一条事件上时到达的事件，不靠新的推送也取得到（ACP、DSH 各一条）。两条在旧的等待逻辑上都失败、修复后通过 | 通过 |
| kimi-web：写文件帧在途只预告路径、不带内容、不重复；失败的轮留预告、不落 `file_written`；无身份 / 无路径不预告；从未在途观察过的轮不变（`kimiWeb.test.js` 0072；0071①② 的期望随之更新） | 通过 |
| 真机 deepseek-flash（`run_202610130838244777zxth2`）：命令 14 秒时到达，MCP `run_activity` 在 +15 秒起每次都列出 `tool_use tool="pwsh" detail="sleep 40"`；命令 55 秒结束。修复前的对照（`run_20261013083340545tweniq`）：同一条要到 53 秒才出现 | 通过 |
| 真机 kimi（`run_20261013083931025fwme13`）：29 秒落 `tool_use tool="Write" detail="note-0072.txt"`，44 秒落在跑的命令，`file_written` 在整轮完成（94 秒）时落 | 通过 |
| 真机评分门控：glm-flash（zcode，`run_20261013084132306fghtqp`）带 `requireCommands` → 评分不通过、运行 failed，`detail` 写明原因与出口；sol（codex，`run_20261013084231057c07z34`）→ 自带退出码 0，通过 | 通过 |
| 全量 `npm test` | 见提交说明 |

## 会审

consult_20261013090407761b947mf（kimi + sol，审提交 c0c8dff）。sol 判"修完再合"，kimi 判通过。两席都判：丢唤醒修复没有新竞态、不改事件内容与先后，别的后端没有漏修；deepseek-acp 的在途 `tool_use` 不会出现在不该出现的地方；kimi 写文件预告不会被任何下游当成写文件证据或意图，决定 0071 的两道门仍成立，这一项不越界；评分门的接线完整（生产调用方只有一处，`this.backend` 在 start / resume / attach 上都是真实实例）；认证脚本的链路自洽。分歧在 Q4：sol 判评分门的可信依据站不住，kimi 判站得住。kimi 席在 10 分钟等待窗之后才答完——到期时用 `status` 看过仍在输出，没有中止。

| 席位 | 意见 | 处置 |
|---|---|---|
| sol（必改） | 以类声明为门在架构上对，但 kimi-code 的 true 声明撑不起严格推断：`isError` 是关键词匹配，有构造反例；deepseek-harness 缺负向证据。不能凭类声明与正向探针宣称门控可靠 | 采纳事实，改口径：声明是门不是证明——写进决定第 4 条、`scorecard.js` / `kimiCode.js` 注释、runbook、usage、TD-197。两条声明是否翻转会改认证结论，报 Owner 裁定，本批不动 |
| kimi | Q4 判站得住：声明轴是认证层每次都在重证的单一真相 | 机制保留；"重证"只覆盖正向样本，不采纳为可靠性证明 |
| sol（必改） | 文实不符：runbook 仍写能力交叉提示"两条"；`registry.js` 注释把提示写成"把失败提前"；"到达即落"说过头；usage 的"结果在工具结束时落"漏了写文件例外 | 采纳，逐处改 |
| kimi（后续） | 真失败与未知退出码混在同一条规则里时，追加的解释句读起来像在说真失败；声明为否的后端上探针的 `commandExitCodeEvidence` 文案像探针异常；`registry validate` 的提示只覆盖 agent 级配置 | 采纳，本批顺手改：解释句限定到 `exitCode=undefined` 的命令；探针文案按声明区分；usage 写明范围 |
| sol、kimi（后续） | 新增 `tool_use` 对 `requireEvidence`、`completed_empty`、诊断门槛的影响；临时规则派发时没有前置提示；认证演练未重跑；kimi 帧 ID 与输入的稳定性、deepseek-harness 的真机证据 | 写进"如实边界"，登记（TD-197） |

会审之后的修复没有再送一轮。
