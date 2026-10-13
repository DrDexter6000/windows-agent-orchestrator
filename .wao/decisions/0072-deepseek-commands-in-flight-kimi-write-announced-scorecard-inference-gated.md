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
| kimi-code | 是 | 729 | 0 | 518 | 211 |
| zcode | 否 | 1337 | 0 | **1335** | **0** |
| kimi-web | 否 | 865 | 0 | 842 | 22 |
| deepseek-acp | 否 | 93 | 0 | 0（关联键是工具名，推断本来就接不上） | 0 |

zcode 上这条推断从没推出过一次失败：`requireCommands` 在 glm 车道上只验了"命令跑过"，没有验"命令通过"。历史上靠它通过的评分共 18 次（zcode 12、kimi-web 6），全部是认证演练（`scripts/reliability-tmp`，2026-10-01 至 10-06），没有 Lead 的实际任务。

## 决定

1. **deepseek-acp 的 shell 调用到达即落一条 `tool_use`**（带命令原文）。`command` 证据仍在终态落（那时才可能有退出码），命令条数不变。codex 自决定 0070 起是同一形状。
2. **修掉两个 deepseek 后端事件队列的丢唤醒**：等下一次推送之前先看队列里有没有东西。只改时机，不改内容与顺序。
3. **kimi-web 的写文件帧在途预告**：输入里出现路径后落一条 `tool_use`，输入只带 `path`（不带文件内容）。不落 `file_written`、不落结果——写文件证据仍只在这一轮带着正文完成时落，失败的轮、没有正文的 completed 轮照旧不落（N1 不变）。没有身份（`toolCallId` / `frameId`）的帧照决定 0071 的规则在途跳过。
4. **评分的退出码推断按后端声明门控**：`checkScorecard` 新增 `inferCommandExitCode`，默认关；`RunManager` 按 backend 类的 `reportsCommandExitCode === true` 传入。这条声明的含义本来就是"WAO 今天能否为这个后端产出命令退出码证据（含这条推断通道）"，认证层一直按它判，产品侧的评分此前没有跟上。
   - 声明为否的后端（zcode / kimi-web / deepseek-acp）上，命令事件不带数值退出码时 `requireCommands` 通不过。实测这三个后端的命令事件都不带（上表）；deepseek-acp 留有一条从输出文本里提取 `exit code: N` 的通道，提取到数值时照数值判，真实转录里一次没有提取到过。检查的 `detail` 保留原有的 `exitCode=undefined` 形状（认证脚本靠它区分"证据不可得"与"观察到非零退出"），并追加一句原因与出口：改用 `requireAcceptance`（独立脚本验收），或把 `mode` 设为 `"warn"`。
   - `wao registry validate` 对"agent 配了 `scorecard.rules.requireCommands`、后端不产出退出码证据"给出 ⚠（与 tokenBudget、sessionReuse 的同类提示并列）。
   - 认证脚本的角色合同探针（`componentDrills.mjs`）此前无条件带 `requireCommands`；门控生效后它会让 zcode / kimi-web 的探针 run 被评分门判 failed，角色合同那一格随之变成"未评估"。改为只对声明为是的后端带这条规则。

## 行为变化与如实边界

- **deepseek-acp 的转录每条 shell 命令多一条 `tool_use`**。`run_activity` 在命令结束后会同时列出这条 `tool_use` 与 `command`（codex 相同）。证据条数、活动条数相应增加。
- **两个 deepseek 后端的事件落盘时机提前**：此前滞留的事件现在到达即落。历史转录里这类事件的时间戳晚于实际发生时刻。
- **失败的 deepseek-acp 运行里会留下在途的 `tool_use`**。在 shell 调用到达与结束之间失败的运行，此前转录里没有这次调用的任何痕迹；现在有一条 `tool_use`，满足诊断"有活动无产出"（`no_effect`）的活动条件，这类运行的诊断可能从 `crash` 变为 `no_effect`（codex、kimi-web 在决定 0070 / 0071 之后同理）。
- **kimi 的预告只说"调用了写文件工具、目标是哪个路径"**，不是文件已写入的证据；失败的轮里留下预告而没有 `file_written`，不代表磁盘上没有写。只在最后一拍才看到的轮没有预告，转录与此前相同。输入就绪后路径若被改写，预告的是当时看到的那一版。
- **`requireCommands` 在 glm / kimi 车道上从"跑过就通过"变为"通不过"**（deepseek-acp 一直通不过——它的推断本来就接不上）。gate 模式下运行会转 failed。这是修正：此前 zcode 上的通过只说明命令跑过，kimi-web 上的通过把"工具结束"当成了退出码 0。
- **认证层的判定不变**：声明为否的后端上 `commandsPassed` 仍记 N/A（不置绿、不算失败）。变化在演练 run 自身的状态——zcode / kimi-web 的严格评分演练 run 此后以 failed 收尾（deepseek-acp 一直如此）。认证演练消耗 token，本批没有重跑。
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

见提交说明（会审在本文件成稿之后进行）。
