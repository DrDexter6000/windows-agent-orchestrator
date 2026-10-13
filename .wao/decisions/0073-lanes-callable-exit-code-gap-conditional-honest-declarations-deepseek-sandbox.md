# 0073 各车道可被 Lead 正常调用：退出码证据轴不适用的车道评 conditional；两处退出码声明翻为"否"；deepseek 车道的沙箱权限与输出可见性

- 日期：2026-10-13
- 状态：accepted（Owner 2026-10-13 裁定并授权，原话见"来源"）
- 来源：Owner 2026-10-13 对决定 0072 收尾报告的回复（原话）——"1、deepseek-harness应是两个deepseek车道的后端；2、我的最终目的是希望几个车道都能被正常使用起来，我可以接受部分车道的能力评价是conditional，但要能正常被lead agent通过wao来调用；3、我授权和同意你基于会审意见、你作为lead agent的最终决断来做出必要的动作、以达到我们追求的目标目的"；随后补充"哦deepseek车道是用的deepseek harness的acp通道哈？"（是：两条 deepseek 车道跑的是 DeepSeek Harness，经它的 ACP 通道，WAO 里对应的后端类是 `deepseek-acp`；同名的 `deepseek-harness` 后端类是同一个 harness 的旧接线，本机没有车道用它）。
- 关系：决定 0072 会审遗留的"两条退出码声明是否翻转"；`scripts/reliability/certification.mjs` 里"任何放宽都须 Owner 明示裁定"的那条注释；决定 0069 / 0070（Lead 看得到 worker 在做什么）；ADR-0031（dsh ACP 后端只 detect / invoke / report）。
- 会审：见文末"会审"。
- 合入授权：Owner 2026-10-12——"只要是你联合会审过的，我都许可 commit & push"。

## 背景

### 实测：8 条车道各派一个最小任务

按 Lead 的真实路径（MCP `run_dispatch`，工作目录为本仓主检出），给 8 条车道各派"跑一条 `node --version`、回一句话"：

| 车道 | 后端 | 结果 |
|---|---|---|
| glm-flash、glm-pro | zcode | 正常 |
| astra、sol | codex | 正常 |
| opus | claude-code | 正常（长期令牌模式，CLI 登录文件未被触碰） |
| kimi | kimi-web | 同时派 8 条时这一次上游报"Request timed out"；单独重跑正常 |
| deepseek-pro | deepseek-acp | 命令在沙箱里 3 次都失败；模型改为申请完全权限、WAO 按既有规则应答放行后才跑成 |
| deepseek-flash | deepseek-acp | 命令在沙箱里失败，模型放弃，回报"命令没跑起来" |

认证状态不拦派发：MCP 的认证门默认关，8 条车道都被受理。

### deepseek 车道：沙箱在项目目录上建不起来

失败原文是 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作目录>)`。单独重跑、换成同盘一个全新的空目录都复现；在用户临时目录下则正常。DeepSeek Harness 自带的 `dsh-sandbox-windows-acl` 文档写明了原因：被授权目录必须由调用者拥有并具备完全控制——沙箱的完整性标签在 SACL 里，需要 `WRITE_OWNER`，而所有者隐式只有 `READ_CONTROL` 与 `WRITE_DAC`；"DACL 只授予 Modify 的目录现在会大声失败"。本机 D: / E: 盘的项目目录正是这种情况（当前用户是所有者，权限来自"Authenticated Users: 修改"）。

这不是今天才有：本机 19 次 deepseek-acp 真实运行里 10 次出现过这句报错（最早 2026-10-02，含 `E:\d2-domain` 与认证演练目录），此前没有任何记录或提示。

Harness 自带修复脚本（`diagnose-windows-sandbox-acl.ps1`）：给该目录补上当前用户的完全控制项，改动有备份和恢复命令。

### deepseek 车道：工具输出在 `run_activity` 里一直是空的

决定 0070 给 `run_activity` 的工具结果加了输出尾部，但只认字符串。deepseek-acp 的工具结果是 ACP 的嵌套文本块（`{type:"content", content:{type:"text", text}}`）——真实转录 314 条无一例外——所以这条车道的 `tail` 始终为空，上面那句报错 Lead 也看不到。

### 认证：case 是 draft-only，车道靠逐条例外才是 conditional

`certifyCase` 对"必需的 strict 检查不适用"判 draft-only，并留了一句注释：放宽须 Owner 明示裁定。不产出退出码证据的五条车道（glm-pro、glm-flash、kimi、deepseek-pro、deepseek-flash）因此在盘上的 case 都是 draft-only，原因写的正是"需要 Owner 明示放行"；Lead 看到的 conditional 来自 `config/lane-exceptions.json` 里逐车道签的五条例外。这带来两个问题：换一个模型就要再签一条；而且例外挂在"越界写对抗"那条红检查上——哪天那条检查转绿，车道反而掉回 draft-only。

可选的认证门（`--require-certified` / `WAO_MCP_REQUIRE_CERTIFIED`，默认关）放行 certified 与 conditional，拒绝 draft-only。

### 两条退出码声明

决定 0072 把评分的退出码推断改为以后端的 `reportsCommandExitCode` 声明为门。会审（sol）指出：kimi-code 的声明依据不成立（`isError` 是对输出文本的关键词匹配），deepseek-harness 缺负向证据。

## 决定

1. **kimi-code、deepseek-harness 的 `reportsCommandExitCode` 翻为 false。** 没有证据就不声明。声明为 true 的只剩自带数值退出码的 codex / opencode-serve，和逐条证明过推断通道的 claude-code——评分的门与 `run_activity` 的闭集至此在效果上一致。本机没有注册使用这两个后端的车道。
2. **命令退出码证据这一轴不适用的车道评 conditional。**（Owner："我可以接受部分车道的能力评价是conditional，但要能正常被lead agent通过wao来调用"）`certifyCase` 里，必需 strict 检查的"不适用"如果全部落在命令退出码证据轴（`capability=commandEvidence`，即后端如实声明不产出），case 评 conditional（监督派发），封顶 conditional、拿不到 certified。范围只有这一条轴：其它 strict 轴不适用、strict 证据不足（inconclusive）、strict 失败（含观察到的非零退出）仍是 draft-only；core 失败仍是 rejected。
3. **deepseek-acp：沙箱建不起来时把原因和修法写给 Lead。** 工具结果命中那句固定报错时，每个运行落一条 system 消息（不进证据链）并记一条异常。WAO 不代为修改目录权限——修复由操作者对每个项目目录执行一次 harness 自带的脚本，用法写进 `docs/usage.md`。
4. **`run_activity` 的输出尾部也读文本块数组**（平铺的 `{type:"text"}` 与 ACP 嵌套块；非文本块不贡献内容）。共享投影只认形状，不按后端分支。

## 行为变化与如实边界

- **kimi-code、deepseek-harness 上 scorecard 的 `requireCommands` 通不过**（命令事件不带数值退出码、评分不再推断），与 zcode / kimi-web / deepseek-acp 相同。这两个后端的车道重新认证时，退出码这一格记"不适用"、车道评 conditional。
- **盘上已有的 case 不重判。** `runs/reliability-summary.json` 里缓存的 case 结论要到该车道下次认证才刷新；在此之前车道的 conditional 仍来自例外条款。用分支代码对盘上 14 个 case 干跑重判（不写盘）：那六个 draft-only 的 case 变为 conditional，其余不变，重判后各车道的状态与现状一致。
- **例外条款没有动。** 五条车道例外此后对"退出码轴不适用"不再是必需的，文件保留。
- **认证门若打开，目前仍只有 astra / sol 过得去**：conditional 车道被拒的原因是另一条——没有全量口径的新鲜认证（`lastFullHealthyRunAt` 为空）。门默认关，本批没有改它。
- **deepseek 的沙箱问题 WAO 只报告、不修复。** 目录权限没修之前，这两条车道在该目录下的行为取决于模型：申请完全权限（WAO 按 ADR-0031 §3.5 的既有规则应答放行，命令随即在沙箱外执行），或者放弃。"修复后恢复正常"的依据是 harness 文档与两处观察（用户有完全控制的目录正常、只有修改权限的目录失败，含全新空目录）；修复脚本本批没有执行过。
- **system 提示每个运行一次**，命中的是 harness 的固定报错文本；harness 改了文案就不再命中（退化为没有提示，不会误报）。
- **kimi 那次超时没有复现**：8 条同时派发时出现一次，单独重跑正常；失败归类为"未知"。
- **`extractExitCode` 在真实数据上从不生效**：它读平铺文本块，线上是嵌套块。没有顺手接上——从命令的标准输出里读"退出码"不是证据。登记。
- **没有真机验证的**：kimi-code、deepseek-harness（本机无车道）；认证演练没有重跑。

## 验证

| 项 | 结果 |
|---|---|
| 认证规则：退出码轴不适用 → conditional、封顶；其它 strict 轴不适用、混入第二条 strict 不适用、无标记的不适用 → draft-only；旁边有 strict 失败 / 证据不足 / core 失败时不被冲淡；观察到的非零退出仍是 strict 失败（`reliabilityCertification.test.js` 0073 三条；原 F1 用例随之改写，G2 与"全不适用"用例未动） | 通过 |
| 真实数据干跑：盘上 14 个 case 用分支代码重判，6 个 draft-only → conditional，其余不变；主干代码重判无此变化 | 通过 |
| 能力快照矩阵与生成面（`backendCapabilityValidate.test.js`、`docs/surface/certification.md` 两格由 ✅ 变 —） | 通过 |
| deepseek-acp：命中固定报错落一条 system 提示、同一运行只落一次、别的失败不落（`deepSeekAcp.test.js` ACP 0073） | 通过 |
| 输出尾部读嵌套块 / 平铺块、按序拼接、脱敏照常、非文本块为空（`runActivityProjection.test.js` 0073） | 通过 |
| 真机（分支代码，deepseek-flash，主检出目录，`run_2026101312211506167s86l`）：`run_activity` 依次列出命令、结果尾部（那句报错原文）、system 提示、模型的回报 | 通过 |
| 真机（8 条车道经 MCP 各一次，主干代码）：见"背景"表 | 6 条正常；kimi 一次上游超时（重跑正常）；deepseek 两条受目录权限影响 |
| 全量 `npm test` | 见提交说明 |

## 会审

见提交说明（会审在本文件成稿之后进行）。
