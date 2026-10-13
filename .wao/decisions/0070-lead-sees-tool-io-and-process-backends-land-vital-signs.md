# 0070 Lead 看得到工具在对什么动手、最近吐出了什么；进程式后端在静默期落生命体征；MCP 硬上限抬高

- 日期：2026-10-13
- 状态：accepted（Owner 2026-10-13 裁定，原话见"来源"）
- 来源：Owner 2026-10-13 对决定 0069 收尾报告的回复（原话）——"1、允许抬高 MCP 硬上限；2、同意你的其它意见"。"其它意见"指报告里留给他定的三项与一项追认：
  - 再给两样信息：工具调用的输入摘要（读的哪个文件、等的哪个后台任务），以及最近一条工具输出的尾部——他在 0069 里说的"最新/最近吐出的动作/信息"，0069 只落成了"条目最新在前"。
  - 给 codex / claude-code 加只读的"进程在干活"事实（只给 Lead 看，不自动中止）。
  - 追认 0069 对 MCP 冻结上限与描述冻结线的重冻。
- 关系：决定 0067 / 0068 / 0069 的延伸；关闭 0069"未做"里的两项；不变量 3（取样留在 Backend 内）与不变量 4（取样只供观察，去留归 Lead）。
- 会审：见文末"会审"。
- 合入授权：Owner 2026-10-12——"只要是你联合会审过的，我都许可 commit & push"。

## 决定

1. **MCP 硬上限抬高。** Owner 没有给数值；沿用 2026-09-22 那次的口径按 10% 落地：工具清单整体上限 85,939 → 94,532 字节（×1.1 向下取整），描述上限 12,347 字节不动。授权记录在 ADR-0032 修订节。本批之后实测 86,061 字节。
2. **下钻再给两样。**（`src/application/runActivityProjection.js`）
   - tool_use 条目新增可选 `detail`：输入里最能说明"在对什么动手"的那一个字段，按 `command` → `file_path` → `pattern` → `query` → `url` → `task_id` → `skill` → `path` → `description` 的顺序取第一个非空字符串；脱敏、清控制字符、截到 200 字符。没有这类字段（例如只有一个待办数组）就不带 `detail`。输入对象本身仍不给。
   - tool_result 条目新增 `tail` 与 `truncated`：输出的最后 400 字符（Lead 要看的是最近吐出的那几行——测试结果、报错）。环境密钥值对整段替换；形状兜底只在最后 4000 字符的窗口里做（一条输出可达数百 KB）；窗口开头若落在 PEM 私钥块中间，END 标记之前整段遮掉。输出不是字符串时 `tail` 为空。
   - 键的顺序来自对主检出 `runs/` 的普查（各后端工具输入的常见键）；四个后端（claude-code / zcode / kimi-web / kimi-code）的 tool_result 带字符串输出，deepseek-acp 不带。
3. **进程式后端在静默期落生命体征——只供观察。**（`src/backends/processActivity.js` 的 `createQuietSampler`，`src/backends/processBackend.js`）
   - codex / claude-code / kimi-code 的事件流在转录静默满 5 分钟后取一次基线（worker 运行时进程的后代快照 + 工作目录的变化指纹），30 秒后再取一次比对：后代进程在干活落 `runtime_activity`（`process_active`），文件有变化落 `files_changed`；然后从头再等 5 分钟。判据与 zcode 相同（决定 0067 的阈值）。
   - 它不是收口门。进程式后端仍然没有任何"等不到进展"的自动收口；取样读到什么、读不读得到，都不改变运行的去留。取样事实不算 worker 事件：`silentTimeout`（可选，只管启动后零事件）的语义不变；也不算可用产出。
   - 任何一步取不到（非 Windows、非 git 目录、快照命令失败）只是这一轮不出事实。
   - `CAPABILITY_NOTES.vitalSigns` 的三条进程式登记随之改写。
4. **codex 的命令在途可见，输出落盘。**（`src/backends/parsers/codex.js`）真机验证时发现：codex 的 command 事件要到命令结束才落，一条 7 分钟的命令在途期间转录里没有它——Lead 看不到 worker 在跑什么，Owner 要的"看得出是在 sleep 还是在跑测试"在 codex 车道上不成立。原始流实测（2026-10-13，`WAO_RAW_CAPTURE`）：命令开始帧 `item.started`（`status:"in_progress"`）已带 `command`，结束帧带 `aggregated_output`。解析器现在在开始帧落一条 `tool_use`（tool `shell`，输入即命令），结束帧除原有的 command 事件外把输出落成 `tool_result`（`isError` = 退出码非 0）。command 事件仍只在结束时落一次、带线上的退出码，证据计数里 command 的个数不变；codex 运行的转录从此多出 tool_use / tool_result 两类事件。

## 如实边界

- **静默取样对 codex 很少触发。** codex 在等命令时每隔一两分钟会自己发一句话（真机：7 分钟里 4 条），转录因此到不了 5 分钟静默——这本身就是生命体征，取样不必出场。取样主要服务 claude-code / kimi-code：它们在工具调用期间不出声。
- **模型长思考期间，进程式后端仍读不到体征。** 等模型回话时 CLI 进程不耗 CPU、没有子进程、不写文件——取样读不出"活着"。这段时间转录里依旧什么都没有。
- **deepseek-harness / deepseek-acp 没有接这项取样**（它们不是 `ProcessBackend` 的子类）。登记文字如实保持"长工具调用期间不落体征事实"。
- **取样读数会看错，方向与 zcode 相同**：无关的后代进程在耗 CPU、别人在同一个未隔离的目录里写文件，都会读成"有体征"。它只是给 Lead 的线索。
- **输出尾部的暴露面比命令原文大。** 工具输出可以是任何东西（文件内容、接口响应）；没有形状的秘密、4000 字符窗口之前的部分都不经形状兜底——后者不会出现在 400 字符的尾部里，但前者会。
- **输入摘要里的路径照原样给出**，而 `file_written` 的路径字段仍不给绝对路径——两处不一致，未改。
- 5 分钟、30 秒、200 / 400 / 4000 字符都是凭经验取的值。

## 未做

- deepseek 两个后端的静默期取样。
- `file_written` 路径字段与输入摘要的口径对齐。
- 形状兜底用到 message 文本（0069 登记项，未改）。

## 验证

| 项 | 结果 |
|---|---|
| 取样器：静默满门限才取基线、窗口满再比对；CPU 在涨落 `process_active`、指纹变了落 `files_changed`；worker 落事件即重新起算；探针抛错 / 不适用只是这一轮不出事实（`createQuietSampler` 三条） | 通过 |
| 进程式后端事件流：静默期落体征事实且不改变完成判定（`completed_empty` 照旧）；读不到体征时零事件、不收口；`silentTimeout` 的"启动后零事件"语义不被取样事实改变；假 spawn 不给探针时不建取样器（`0070-B1`–`B4`） | 通过 |
| 输入摘要：字段顺序、缺席、脱敏、200 字符上限、输入对象不出（`0070-P1`）；输出尾部：取尾、`truncated`、环境值与形状脱敏、PEM 块中间起窗、非字符串输出（`0070-P2`） | 通过 |
| codex 解析器：开始帧落 `tool_use`、结束帧落 command + `tool_result`、不带 command 的开始帧忽略（`test/parsers/codex.test.js`） | 通过 |
| 真机（无模型，真 `ProcessBackend` 事件流 + 真 PowerShell 快照 + 真 git 指纹，门限缩到 15s / 10s）：子进程忙循环 → 第 27s 落 `process_active`；子进程空等 → 无事实；子进程每 2s 追加一行 → 第 27s 落 `files_changed`；三种情况事件流都在进程退出的同一秒结束 | 通过 |
| 真机（codex 车道 `sol`，真门限）：`sleep 420` 静默 443s 期间没有落任何体征事实（CLI 自己的后代进程没有被读成在干活），正常完成；慢速写文件命令期间 codex 每隔一两分钟发一句话，取样未触发 | 通过 |
| 真机（codex 车道 `sol`，改解析器之后，`run_20261013062113839kf37a0`）：命令在途时 MCP `run_activity` 第一条即 `tool_use tool=shell detail="…pwsh.exe" -Command 'echo starting; sleep 70; …"`；结束后转录里有 command 与 `tool_result` | 通过 |
| MCP 工具清单体积：85915 → 86061 字节，新硬上限 94532 | 通过 |
| 全量 `npm test` | 见提交说明 |

未做真机验证的：claude-code / kimi-code 车道上带模型的静默取样（`opus` 车道的登录凭据有被冲掉的已知风险，没有用它做试验；仓库里没有注册 kimi-code 车道）——用的是上面那组无模型的真进程验证。

## 会审

见提交说明（会审在本文件成稿之后进行）。
