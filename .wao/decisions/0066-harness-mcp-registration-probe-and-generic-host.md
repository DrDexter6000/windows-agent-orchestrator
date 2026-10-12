# 0066 MCP 宿主适配：注册状态只读探测 + 六宿主入表 + 表外宿主通用片段（TD-191 续，修订 0043 第 2/3 条）

- 日期：2026-10-12
- 状态：proposed（实现与真机验证已完成，待 Owner 审阅合入）
- 会审：Owner 当日指示"最终交付物发给 kimi 和 sol 看一下"——consult_202610121557386770ygr68（kimi `run_202610121557387053debaf` / sol `run_20261012155738775le77bw`，审的是提交 243da09）。两席均为 MERGE_AFTER_FIXES：sol 七条必改、kimi 一条必改，全部采纳，见文末"会审必改"。
- 来源：Owner 点名"MCP 必须适配所有 agent harness，现在只适配 codex 是不对的"（经 2026-10-12 Carloha 宿主项目消费者侧反馈任务书转达）；范围由 Owner 当日四项裁定：① 宿主清单 = claude-code、codex、zcode、kimi-code、opencode + Claude 桌面聊天端；② 产品面"出命令 + 只读探测"，不扩 autoBind，本机注册与真机验证由执行会话代办；③ 全局入口指向开发工作树一事本批只登记、不动 0049；④ 第三节另行处置（见 tech-debt）。

## 背景（2026-10-12 实测）

- 帮助文本的 Workspace activation 节只列 `--host codex`；Claude Code 里当 Lead 的会话据此认定 MCP 只支持 codex，全天退回命令行（9 次派发）。
- `mcp status --host claude-code` 返回 `not_applicable`（0043 第 3 条）——"这个 harness 上注册了没有"无处可问。
- `onboarding --host <id>` 的宿主指引排在 worker 选择矩阵之后，第一屏只见 NEEDS-SELECTION。
- 表外宿主（kimi-code、opencode）只得到 `unsupported host`；而 kimi-code 实际早已手工注册在用。
- 本机实况：Claude Code 仅在 WAO 仓库目录有 local 级注册（换个项目就没有）；codex、kimi-code 用户级已注册；zcode 插件在位；opencode、Claude 桌面端未注册。

## 决定

1. **宿主表扩到六个**：新增 `kimi-code`、`opencode`、`claude-desktop`（均 snippet-only）。opencode 片段形态 = 顶层 `mcp.wao {type:"local", command:[argv…], enabled:true}`；另两者 = mcpServers。文件式注册的宿主带 `configHint`（要并入的配置文件），`mcp bind` 输出为 `configFile`。
2. **修订 0043 第 3 条**：snippet-only 宿主的 `mcp status` 不再返回 `not_applicable`，改为**只读探测宿主自己的配置**，四态闭集 `registered` / `registered_other_target` / `not_registered` / `unknown`，并列出看过的每个来源。边界写死：**读面新开、写面不动**——WAO 从"不碰其他宿主配置"变为"读但绝不写"，只提取 wao 条目，配置内容不进输出（`sources` 只回显路径与状态）。纪律：只读、不 spawn；只有文件确实不存在（ENOENT/ENOTDIR）才算没有，其余读取失败、解析失败一律 `unknown`，绝不折算成未注册；多来源按宿主自己的覆盖优先级取**生效条目**（高优先级来源读不了 → unknown），被禁用的条目记 `not_registered`；`registered` ≠ 已加载。新宿主入表须同批提供探测（测试守卫）。
3. **codex 两层**：`mcp status --host codex` 在项目级绑定状态之外附 `userRegistration`（经 `codex mcp list --json` 读用户级，不解析 TOML）。项目未绑定但用户级已注册时 Lead 在 codex 里照样有工具。
4. **`mcp status` 不带 `--host` = 全宿主一览**（原为报错）。
5. **修订 0043 第 2 条的 bind 面**：表外宿主 `mcp bind` 不再只报错，emit 通用 stdio 片段并明说 `GENERIC SNIPPET — NOT BOUND, FORMAT NOT VERIFIED`。command/args 是宿主中立事实，不构成格式猜测；该宿主的配置语法与加载结果一概不声称。`status` 对表外宿主仍是 `unsupported_host`（附"WAO 对它没有探测"的说明），`unbind` 仍报错。
6. **`onboarding --host`**：宿主指引块排第一屏；表外宿主给通用指引，不再非零退出。
7. **帮助文本**：`MCP host registration` 节列全表内宿主与三条命令的真实语义（测试守卫：表内宿主必须都出现在帮助里）。
8. **派发 advisory**：`run` 派发发生在可识别的宿主会话里、而该宿主未注册 WAO MCP 时，stderr 一行提示 Lead 自己走的是命令行通道。识别只用描述符表 `detectEnv` 里**真机核实过**的环境标记（claude-code `CLAUDECODE`；codex `CODEX_THREAD_ID`；opencode `OPENCODE`；kimi-code、zcode、claude-desktop 无可靠标记，不识别）。fail-open；**每个宿主会话只判一次**（会话键取描述符 `sessionEnv` 的值，缺席按 UTC 日；状态文件只存键的短哈希）——命令行是合法通道，这不是违规告警，不套用 0042 ③ 的"超帽恒弹"（初稿是每次派发都出，两席会审均点名警报疲劳，已改）。codex 不出此行（其注册状态要 spawn CLI 才知，派发路径不付这个代价）。
9. **不变**：autoBind 闭集仍 = {codex}；WAO 仍不写任何其他宿主的配置；MCP 工具面零触碰（无 wire refreeze）。

## 真机验证记录（2026-10-12，本机）

| 宿主 | 注册动作 | 验证方式 | 结果 |
|---|---|---|---|
| claude-code | `claude mcp add wao --scope user -- <argv>`（新增用户级） | `claude mcp get wao` 健康检查；中立仓库 `claude -p` 无头会话 | Connected；列出全部 23 个 `mcp__wao__*` 工具，`workspace_status` 返回 bound=true（root=中立仓库） |
| codex 0.159.2 | 原已用户级注册，未改 | `codex mcp get wao --json`；中立仓库 `codex exec` ×3 | 一次列出 23 个工具；一次 `wao.workspace_status` 调用 completed（bound=false）；**另一次会话报告没有 wao 工具**（未复现原因，见 TD-191） |
| kimi-code 2.1.1 | 原已注册（2026-09-07），未改 | 中立仓库 `kimi -p` 无头会话 | 列出 23 个工具，`workspace_status` 返回 bound=false / root=null（该宿主不提供 MCP roots） |
| opencode | 并入 `~/.config/opencode/opencode.json`（新增，原文件已备份） | `opencode mcp list`；中立仓库 `opencode run` | wao connected；列出 23 个工具（前缀 `wao_`），`workspace_status` 返回 bound=true |
| zcode | 2026-10-03 插件包，未改 | 宿主自身当日日志 | `plugin:wao:wao` 当日 3 次 connected、toolCount=23（均为 WAO 派发的 worker 会话，非 Lead 交互会话） |
| claude-desktop | 并入 `%APPDATA%\Claude\claude_desktop_config.json`（新增，原文件已备份） | **未验证**——需重启桌面端 | `hostVerified=false`，待 Owner 重启后确认并置位 |

注册全部指向开发工作树路径（0049 现状）；将来若切发布快照，每个宿主重跑一次注册即可，`mcp status` 的 `registered_other_target` 会如实指出指向不一致的宿主。

## 后果与未尽事项

- **无注册子命令的宿主没有"一条命令注册"**：kimi-code、opencode、claude-desktop 的注册是"把片段并入某个文件"，两步而非一条命令。要做到一条命令，须扩 autoBind（WAO 写宿主配置，含回滚纪律）——Owner 本批裁定不做。
- 长等待工具（`run_wait` 等最长 600s）在 kimi-code / opencode / claude-desktop 上是否会被宿主侧工具超时截断，未验证（zcode 因此带 `timeoutMs`）。
- codex 一次会话未见工具的原因未查明。
- 派发 advisory 对 kimi-code / zcode 会话不生效（无可靠环境标记）。
- 以上四条登记在 TD-191。

## 会审必改（consult_202610121557386770ygr68，全部已改并补测试）

| 席 | 问题 | 处置 |
|---|---|---|
| sol | `existsSync=false` 把权限错误也当成文件缺失 → 误报未注册 | 不再用 existsSync；只认 ENOENT/ENOTDIR，其余 unknown |
| sol | JSONC 回退会改写字符串里的 `,}`、放过未闭合块注释 | 重写为字符串感知的剥离器；未闭合即解析失败 |
| sol | 多来源"任一命中即 registered"，无视覆盖关系 | 按宿主优先级取生效条目；高优先级读不了 → unknown |
| sol | opencode 忽略 `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` | 按官方覆盖顺序纳入（本机只核实过全局文件形状，注释如实写明） |
| sol | `workerDeclared` 误认空声明、合同模板原文、围栏里的复述 | 要求合同形状（非空路径 + 破折号 + 非空理由），排除占位符与围栏 |
| sol | 验证闸快照被说成"在跑/排队/未开始" | 只报租约事实（持有者、开始时间、心跳年龄） |
| sol | onboarding 让 opencode 粘 mcpServers 片段；SKILL 把"工具没列出"等同"未注册" | 文件式宿主改指 `mcp bind` 输出的本宿主形态；SKILL 改为"检查 `mcp status`" |
| kimi | `docs/02-architecture.md` 冻结工具面段仍是三宿主、"表外 fail-closed"旧表述 | 改为指向描述符表与本决定 |

同批采纳的非阻断建议：zcode 缓存多版本不一致报 unknown；被禁用条目不算注册；路径做词法归一；流分片只认 `chunkLength > 0`；零 part 门不看证词的说明；advisory 改每会话一次；测试套件子进程环境剔除宿主识别标记（套件结果不随启动它的 harness 变化）。
未采纳/留待 Owner：`~/.claude.json` 读取的尺寸上限（现每会话至多读一次，未加上限）；junction/8.3 短名等文件系统级路径别名不解析（会如实报成 other_target）。
会审收据的字段抽取把两席的 `MERGE_AFTER_FIXES` 都记成了 `MERGE`（选项互为前缀时的抽取缺陷，登记 TD-268）——以席位正文为准。
