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

1. **MCP 硬上限抬高。** Owner 没有给数值；沿用 2026-09-22 那次的口径按 10% 落地：工具清单整体上限 85,939 → 94,532 字节（×1.1 向下取整），描述上限 12,347 字节不动。授权记录在 ADR-0032 修订节。本批之后实测 86,066 字节。
2. **下钻再给两样。**（`src/application/runActivityProjection.js`）
   - tool_use 条目新增可选 `detail`：输入里最能说明"在对什么动手"的那一个字段，按 `command` → `file_path` → `pattern` → `query` → `url` → `task_id` → `skill` → `path` → `description` 的顺序取第一个非空字符串；脱敏、清控制字符、截到 200 字符。没有这类字段（例如只有一个待办数组）就不带 `detail`。输入对象本身仍不给。
   - tool_result 条目新增 `tail` 与 `truncated`：输出的最后 400 字符（Lead 要看的是最近吐出的那几行——测试结果、报错）。两层脱敏都作用在完整输出上，然后才清控制字符、去掉结尾空白、取尾——先切窗再脱敏会丢掉识别秘密所需的上下文。一条输出可达数百 KB，所以尾部只为落在当前页的条目计算。`truncated` 表示脱敏清洗后的文本长于 400 字符（尾部之前还有内容）。输出不是字符串时 `tail` 为空。
   - 键的顺序来自对主检出 `runs/` 的普查（各后端工具输入的常见键）；四个后端（claude-code / zcode / kimi-web / kimi-code）的 tool_result 带字符串输出，deepseek-acp 不带。
3. **进程式后端在静默期落生命体征——只供观察。**（`src/backends/processActivity.js` 的 `createQuietSampler`，`src/backends/processBackend.js`）
   - codex / claude-code / kimi-code 的事件流在转录静默满 5 分钟后取一次基线（worker 运行时进程的后代快照 + 工作目录的变化指纹），30 秒后再取一次比对：后代进程在干活落 `runtime_activity`（`process_active`），文件有变化落 `files_changed`；然后从头再等 5 分钟。判据与 zcode 相同（决定 0067 的阈值）。
   - 它不是收口门。进程式后端仍然没有任何"等不到进展"的自动收口；取样读到什么、读不读得到，都不触发收口。
   - 取样落下的事实仍是 `run.event`，下游照常把它当活动：会触发 `first_event`（submitted → running）、计入 `run_wait` 的 liveness、成为 advisory 的"最近活动"、计入决定 0069 的 stop 新鲜度校验（一条取样事实落下超过 2 分钟后，更早的观察位置会被判过时——重新看过即可）。它不参与的是本后端的 `silentTimeout`（可选，只管启动后零事件）与 `completed_empty` 判据；诊断里也不当作 provider 曾在出流的证据（`provider_disconnect` 的条数与"退出前零 worker 事件"两处判据都把它排除）。
   - 两项读数各自退化：非 Windows 读不到进程，但文件变化仍可落事实；非 git 目录读不到文件，但进程活动仍可落事实；快照命令失败只是这一项这一轮没有读数。两项都取不到才整轮不出事实。
   - 取样探针要跑一两秒；期间到达的事件或进程退出，在探针返回后立即处理（不等下一个取样定时器），那一轮的读数作废。在途纠偏的轮询在取样的那两拍会被推迟这一两秒。
   - `CAPABILITY_NOTES.vitalSigns` 的三条进程式登记随之改写。
4. **codex 的命令在途可见，输出落盘。**（`src/backends/parsers/codex.js`）真机验证时发现：codex 的 command 事件要到命令结束才落，一条 7 分钟的命令在途期间转录里没有它——Lead 看不到 worker 在跑什么，Owner 要的"看得出是在 sleep 还是在跑测试"在 codex 车道上不成立。原始流实测（2026-10-13，`WAO_RAW_CAPTURE`）：命令开始帧 `item.started`（`status:"in_progress"`）已带 `command`，结束帧带 `aggregated_output`。解析器现在在开始帧落一条 `tool_use`（tool `shell`，输入即命令），结束帧除原有的 command 事件外把输出落成 `tool_result`（`isError` = 退出码非 0）。command 事件仍只在结束时落一次、带线上的退出码，证据计数里 command 的个数不变；codex 运行的转录从此多出 tool_use / tool_result 两类事件。

## 如实边界

- **静默取样对 codex 很少触发。** codex 在等命令时每隔一两分钟会自己发一句话（真机：7 分钟里 4 条），转录因此到不了 5 分钟静默——这本身就是生命体征，取样不必出场。取样主要服务 claude-code / kimi-code：它们在工具调用期间不出声。
- **模型长思考期间，进程式后端仍读不到体征。** 等模型回话时 CLI 进程不耗 CPU、没有子进程、不写文件——取样读不出"活着"。这段时间转录里依旧什么都没有。
- **deepseek-harness / deepseek-acp 没有接这项取样**（它们不是 `ProcessBackend` 的子类）。登记文字如实保持"长工具调用期间不落体征事实"。
- **取样读数会看错，方向与 zcode 相同**：无关的后代进程在耗 CPU、别人在同一个未隔离的目录里写文件，都会读成"有体征"。它只是给 Lead 的线索。
- **输出尾部的暴露面比命令原文大。** 工具输出可以是任何东西（文件内容、接口响应、报错正文）；没有形状的秘密会原样出现在尾部里。
- **codex 的转录形状变了，既有判定随之变化**：命令开始帧现在就算可用效应与证据——配了 `silentTimeout` 的运行在命令开始帧之后不再算"启动后零事件"；"开始了命令、随后以退出码 0 结束而没有别的产出"的运行从 `completed_empty` 变为普通完成；一条完整命令从一条证据变成三条（command 个数不变，活动数、证据总数、collect 的条目数增加）；开始帧之后进程崩溃，诊断从 `crash` 变为 `no_effect`（按既有的 tool_use 语义）；`provider_disconnect` 的"≥3 条事件"门限更容易被跨过。退出码未知时 `tool_result` 的 `isError:false` 只表示没有非零退出码，不是成功的证明。
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
| MCP 工具清单体积：85915 → 86066 字节，新硬上限 94532 | 通过 |
| 全量 `npm test` | 见提交说明 |

| 会审后补：取样探针在途时进程退出 → 探针一返回就收尾（`0070-B5`）；没闭合的 PEM 块、超长带名赋值在尾部不漏，取尾不从代理对中间开始（`0070-P3`）；尾部只为当前页计算、形状规则在 320KB 的字母数字串上保持线性（`0070-P4`）；只有取样事实的崩溃仍归 `crash` 且照旧附"退出前零 worker 事件"（`test/transcript/diagnosis.test.js`） | 通过 |

未做真机验证的：claude-code / kimi-code 车道上带模型的静默取样（`opus` 车道的登录凭据有被冲掉的已知风险，没有用它做试验；仓库里没有注册 kimi-code 车道）——用的是上面那组无模型的真进程验证。

## 会审

consult_202610130624274223pdd3p（kimi + sol，审提交 891616f）。两席都判"修完再合"，都抓到同一处竞态。kimi 席用了约 20 分钟才答完——等待窗到期时它还在输出，按决定 0067–0069 的口径没有中止它。两席在 Q4（取样是否做到只供观察）与 Q5（脱敏是否足够）上意见相反：sol 判 BROKEN / NOT_ENOUGH，kimi 判 HOLDS / ENOUGH；sol 给了可复现的反例，按 sol 的处理。

| 席位 | 意见 | 处置 |
|---|---|---|
| sol、kimi（都列为必改） | 事件流在排空队列之后 `await` 取样探针，期间到达的事件或进程退出是在没有等待器时发生的，唤醒丢失——要等新装的定时器（基线阶段约 30 秒、比对阶段约 5 分钟）才交付；sol 的 Q4 因此判 BROKEN | 采纳：等待之前再查一次队列；探针期间有事件则那一轮读数作废；补 `0070-B5` |
| sol（必改） | 输出尾部先切 4000 字符窗再脱敏，识别秘密的上下文落在窗外：没闭合的 PEM 块、超长带名赋值会漏 | 采纳：两层脱敏作用在完整输出上，只为当前页的条目计算；形状规则里无界的 `*` 改有界，另加"只见 END 不见 BEGIN"的逐行处置；补 `0070-P3` / `P4` |
| sol（必改） | 取尾的起点可能落在代理对中间 | 采纳 |
| sol（必改） | 诊断把全部 `run.event` 当作 provider 出流的证据：三条取样事实 + 静默 + 退出码 1 会从 `crash` 变成 `provider_disconnect` | 采纳：两处判据排除控制面自己观察到的体征（`isObservedVitalSign`），补测试 |
| sol（必改） | 文实不符："取样事实不算 worker 事件"只对后端内部成立；"任何一步取不到就不出事实"与按来源各自退化不符；`truncated` 的解释不精确；窗口说法不成立 | 采纳，逐处改写 |
| sol、kimi | 10% 落硬上限不判越权，记录如实；不构成以后自行连续抬高的授权。kimi 请 Owner 对 94532 这个数值作一句明示追认 | 记录，转告 Owner |
| kimi（后续） | `run_activity` 描述里 "written paths (never absolute)" 字面过宽、句首小写 | 采纳，改为 `file_written paths (never absolute)` |
| kimi（后续） | codex 的 tool_use 让 `silentTimeout` / `completed_empty` 的边缘语义漂移，决定里没写 | 采纳，写进"如实边界" |
| kimi（后续） | claude-code / kimi-code 车道首次真实静默运行时复核取样噪声；codex 全量输出入盘后的转录体积；投影整段脱敏的规模边界 | 登记（TD-197） |
| sol（后续） | 辅助进程 / 共用目录的假阳；摘要字段的信息质量（空白串抢占、`pattern` 压过 `path`）；大型转录与多运行并发的开销；codex 新增事件对诊断与证据计数的影响需要更多证据；路径展示口径不一 | 登记（TD-197） |

会审之后的修复没有再送一轮。
