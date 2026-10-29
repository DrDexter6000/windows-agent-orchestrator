# 取结果与查历史

> [使用手册](../usage.md)的一页：取回 worker 的回答、诊断 run、用脚本消费 JSON 输出、列出与统计 run。

## 查看指标

```powershell
# 单个 run 的 token / 耗时 / 成本
npm run cli -- runs metrics <runId>

# 跨 run 聚合
npm run cli -- runs metrics --summary
```

输出示例：
```
runId:    run_20260615223814523
state:    completed
duration: 5.1s
tokens:   input=5518 output=7 reasoning=3761
cost:     $0.0576
```

`runs metrics <runId>` 与 `runs scorecard <runId>` 的事实读取（state/tokens/cost/duration/scorecard 与 reason）按 runId 绑定：尾部追加的外 run 或伪造行不进报表值。两命令的 `runId` 在拼接 transcript 路径前过合法性校验，非法以固定文案拒绝，不回显输入。全无信封的旧 transcript 照常出报表。`run` 前台命令汇总的 scorecard 段与 `npm run smoke` 的 scorecard 判定走同一绑定；`runs metrics --summary` 的逐文件聚合同样绑定，文件名即权威 runId。

评分规则里的 `requireCommands` 要求命中的命令事件带数值退出码 0。后端没有声明 `reportsCommandExitCode` 时，WAO 不从"工具调用成功"推断退出码；zcode、kimi-web、deepseek-acp 的命令事件不带数值退出码，这条规则在它们上面通不过，改用 `requireAcceptance` 或 `mode:"warn"`（`wao registry validate` 会给出 ⚠）。细则见 `docs/certification-runbook.md`。

## 被脚本或 LLM 驱动

WAO 可被任何调用方平等驱动：bash 脚本、LLM 编排器、CI。

脚本化消费 JSON 时，一律用全局 `wao` 命令（天生免疫 npm 噪声）或 `npm run --silent cli --`。裸 `npm run cli --` 会让 npm 在 stdout 打 banner，污染 JSON 输出——只适合人读交互，不要进脚本或管道。

`--format json` 不是全局开关，支持面以命令为准（本页只列常用面，不维护全量清单）：

- 恒为 JSON、无需 flag：`spawn`（含 runId + transcript 路径）；`status`（无 `--format` 分支——flag 是 no-op，被接受但不改变任何行为，输出恒 JSON）；裸 `collect <runId>`（raw ops JSON）。
- `--format json` 显式开启：`run`（JSON 输出含 messages + metrics）；查询族（registry validate / registry check / runs list / runs summary / runs grep / wao decision list / wao handoff read，形状见下）；runs 族多数子命令（wait / gate / metrics / scorecard / diagnose / dashboard / delivery）。
- 已知例外：`collect --final` 接受 `--format json`，但 stdout 恒为四态文本，不输出 JSON 信封（该组合 stderr 警告一次）。机器可读请去掉 `--final`，用分页 `collect <runId> --format json`。

```powershell
# spawn 返回 JSON（含 runId + transcript 路径）
npm run --silent cli -- spawn glm-flash --prompt "..." | ConvertFrom-Json

# run 的 JSON 输出含 messages + metrics
npm run --silent cli -- run glm-flash --prompt "..." --format json | ConvertFrom-Json

# 查询族：registry / runs / wao 的只读子命令（同样支持 --format json）
npm run --silent cli -- registry validate --registry config/agents.json --format json
npm run --silent cli -- registry check --registry config/agents.json --format json
npm run --silent cli -- runs list --format json
npm run --silent cli -- runs summary --format json
npm run --silent cli -- runs grep "error" --format json
npm run --silent cli -- wao decision list --format json
npm run --silent cli -- wao handoff read lead --format json
```

> 下面七个查询子命令的 JSON 输出形状没有生成层，以本节为准（归属见 `docs/ssot.md` §1.3）；改这些命令的输出时同步改这里。

- `registry validate --format json` → `{checked, valid, agents:[{id, ok, issues[], warnings[]}]}`。`id` 为 null 时（键名不合法，不回显），`position` 是按解析后键的枚举顺序计的 1 起序号（整数样式的键排在前面，不一定等于文件里的行序），文本模式对这类条目输出 `✖ #<序号>`。JSON 模式维持 exit code 契约：有错误条目 → exit 1；文本模式的 ⚠ warning 进入 `warnings[]`，不阻塞。registry 源 JSON 解析失败时输出 `{checked:0, valid:false, agents:[], issues:[...]}`——顶层 `issues` 数组只含固定文案，能从报错取到位置时附行列号（如 `registry 文件不是合法的 JSON（第 3 行第 7 列）`），取不到位置时只有固定文案；不回显源文本，exit 1。文本模式：角色合同失败的 agent 只输出一行 `✖ <id>`，不先打 ✔ 成功行再打 ✖。
- `registry check --format json` → `{allOk, agents:[{id, status:"ok"|"fail"|"skip", serveUrl?, error?}]}`；fail 照旧 exit 1。非 opencode-serve 车道的 `skip` 行（文本模式同文案）`error` 是一句固定文案，指路 `wao lanes`（车道就绪）与 `wao doctor`（环境）。
- `runs list --format json` → `{runs:[{runId, agentId, state, terminal, updatedAt, ...}], matchedCount}`（直接序列化共享 listRuns 服务结果）。
- `runs summary --format json` → `{total, byState, latest}`（无事件时间戳时 `latest:null`）。
- `runs grep <pattern> --format json` → `{pattern, matched, matches:[{runId, type, ts}]}`——与文本路径一致，每个 run 只记录首个命中事件，不是全量命中清单。
- `wao decision list --format json` → `{decisions: string[]}`（map.md 索引行原样包装，不做 id/title 解析）。
- `wao handoff read <role> --format json` → 找到时 `{found:true, role, body}`；未找到时 `{found:false}`。

报错文本的控制字符规则（与上面 registry 解析报错同一底线）：CLI 报错（顶层 catch、sessionReuse 拒绝、`npm run smoke` 的顶层 catch 与 `worktree reclaim` 自己打的报错）和 MCP 错误文本（各工具 handler 返回的 `isError` 结果与 handler 抛错）里的控制字符（C0/DEL/C1 与 U+2028/U+2029）一律显示为转义写法——配置值里混进的换行不能在报错里伪造一行。有意分行的报错（派发选择器拒绝、delivery-spec 提示、把顶层命令名当 agentId 的提示、`runs wait`/`consult` 的"报错+用法"、collect 取回失败的指路行、dashboard 的非 Git 目录拒绝）逐行转义后再换行，行数不变。成功输出的 JSON 不加这一层（`JSON.stringify` 自带转义，原值仍可机读）。MCP SDK 自己产生的错误（未知工具名、入参或出参校验失败）不经这一层。

LLM 编排器或外部脚本的最短驱动闭环：

1. `spawn` 启动 run，拿 runId
2. `status <runId>` 轮询状态
3. `collect <runId>` 或读 transcript 拿产出
4. `runs metrics <runId>` 拿成本

## MCP `run_collect`：取回 worker 的回答

`run_collect` 让 MCP host 收集一个 run 的 worker 产出。它与 CLI `collect` 共用同一 application service，不 shell-out CLI。目标必传 `expectedWorkspaceRoot`（run 必须属于它）——归属核验按转录 cwd 的规范路径在任何读取副作用前 fail-closed，不符（另一项目、子目录/非 Git cwd 派出的 run、无归属事实的旧转录）时固定文案拒绝、零写入。非只读非幂等：每次成功调用向 transcript 追加一条 `messages.collected` 审计事件（不改变 terminal state）。

参数与形状见 [docs/surface/mcp-tools.md](../surface/mcp-tools.md)（生成层，随代码再生成）。模型可传 `runId`、可选 `cursor`（opaque continuation token，仅 full 模式可带，值来自上一页的 `nextCursor`）、可选 `mode`（`full|compact`，省略即 `full`）。`runDir`、`limit`、`serveUrl`、`sessionId`、`raw`、`includeTools` 等是 server-owned 配置，模型不能传。

`agentId` 是 transcript 信封盖戳的 canonical worker 身份，来自 collect 已读的同一份 transcript 快照。不解析 worker 自由文本——worker 自报 `/root`、`Coder-HQ`、显示名或完全不报，都不改变这个 `agentId`。缺失或冲突时降级为 `"unknown"`：不抛错、不伪造身份、不是自动停止门。

### 读取绑定

- 会话事实按 runId 绑定读取：`session.created` 取末条绑定行，`run.started` 取首条绑定行。尾部追加的外 run 伪造行对 collect 不可见，也不能重定向 serve 取回的 serveUrl/sessionId/directory 参数。
- 旧格式 transcript（`session.created` 行无 `runId` 字段）的 serve 取回被拒绝：固定文案 `Run <runId> has no session metadata`，不发起 serve fetch、不追加 audit、不伪造参数。`run.started` 缺绑定行时，serve 取回不携带 directory 参数（用 serve 侧默认目录，绝不采用无法归属的 cwd，也不伪造新值）。
- 重建条目只重建本 run 信封绑定的 `run.event`：`messages`/`evidenceCounts`/`itemCount` 等机器消费字段不含不可归属内容。合法的全绑定 transcript 上这层过滤不改变输出。

### 输出边界

- 单页最多 8 条 message，每条 text 最多 4000 字符，全部 text 合计最多 12000 字符。
- 只提取 assistant 角色 message 的 text part；assistant 文本经 secret redactor 脱敏当前进程环境中的凭据值。无 assistant message 时 `messages:[]` 是合法结果。
- `truncated` 分两级：页级 `truncated:true` 只表示"有内容被扣留待续读"，必伴 `nextCursor`；entry 超 4000 字符时，该 entry 的 `truncated:true` 是切片标记，不是数据丢失。
- 绝不返回：command string/argv、tool input/tool output/tool result raw payload、file_written path、cwd、serveUrl、sessionId、PID、unknown event raw object、prompt、环境变量、异常 message/stack。`content` JSON 与 `structuredContent` 语义一致。
- 其它失败只返回固定 `run_collect failed`，不泄漏 SDK output validation error、原始异常、绝对路径或 secret。
- 边界：serve 路径可能读取外部 runtime 服务；不杀进程、不修改 worker checkout、不改变 run terminal。

### 续读

结果超过单页边界（8 条 message、4000 字符/条、或 12000 字符总 cap）时，输出携带 `nextCursor` 而非 `null`。用同一工具传 `{runId, cursor}` 继续读取下一页，直到 `nextCursor === null`。跨页拼接后完整、按序、无漏项、无重复；长单条 message 会在页内中途切分，下页从同一 message 的字符偏移继续；Unicode/CJK/emoji 不会在页边界拆坏 code point。

cursor 是 server-opaque 的 base64url token（≤192 字符），只含 runId 摘要、snapshot 摘要和位置索引，绝不携带 raw runId/sessionId/path/prompt/secret 或任何 worker 文本。跨 run、跨 snapshot、跨位置重放都 fail-closed 为固定 `run_collect failed`。cursor 是纯数据，无进程内 session 状态：Host/MCP 进程重启后仍可续读。

snapshot 在首次 collect 时冻结完整 worker-authored raw 证据序列（所有 message/command/tool_use/tool_result/file_written 事件，不只 assistant 文本）。worker 在分页期间继续追加 `run.event` 不影响续读：只读取冻结前缀，`itemCount`/`evidenceCounts` 与第一页完全一致，不重复也不跳页。篡改历史事件（非追加）会 fail-closed。

投影模式（MCP 恒为投影；CLI `--format json`/`--cursor`）读取完整 snapshot，不会在分页前截断为 50 条；legacy raw CLI `collect <runId>` 保持尾部 `slice(-limit)` 行为。

serve 后端的 `/message` endpoint 本身支持上游分页（`before` 游标 / `X-Next-Cursor`），但 WAO 当前的 serve adapter 每次只发一个 bounded `limit` 请求，不消费上游分页。容量探测用 cap+1 sentinel（10001）：返回 ≥10001 条说明 run 超出当前 adapter 的安全容量（10000），立即 fail-closed 为固定 `run_collect failed`——零 partial、零 audit append，不把"只拿到 serve 尾部"报成"完整读完"。process 与 serve 共用同一分页合同。

### 单页内分块与消息边界

一条长消息若整条在单页预算内（≤12000 字符），会切成多条 ≤4000 字符的 entry 在同一页一次交付：该消息的 entry 按序拼接即全文，`nextCursor:null`。

切片 entry 若不是源消息的开头（同消息的后继切片，或跨页续读后的页首切片），携带 `continuation:true`；消息开头或完整的 entry 不携带该字段——缺席即消息开头，投影层从不发射 `false`。机械重组：带 `continuation:true` 的 entry 拼接到前一 entry 之后，不带的开启新消息。多条消息落在同一页时按此切分，不要把整页 entry 盲拼成一条。跨页续读时，同一消息的切片按序拼接；`truncated:false` 的 entry 收尾一条完整消息。

### 审计追加时机

任何投影/schema 失败——包括 invalid cursor、cursor-less 第一页 service 成功但 projection 失败、output validation 失败——都零追加 audit event。投影模式从第一页起 defer append，projection 与 output validation 全部成功后才追加一次。compact 与 CLI `--final` 遵守同一时机。

### compact 模式

`mode` ∈ `{full, compact}`，省略即 `full`。`compact` 在一次调用内返回最后一条 assistant 文本（经与 full 完全相同的脱敏 + 控制字符清洗，≤4000 字符）和来自同一份完整快照的 `evidenceCounts`/`itemCount`——终态后通常一次 collect 即可看到 worker 的最后结论与完整证据计数。compact 复用 full 的全部提取/脱敏/计数逻辑：不做语义摘要，不替你决定是否需要 full 输出。

compact 不接受 cursor（cursor 仅 full 可带）：`compact+cursor` 在 service/read/append 之前 fail-closed 为固定 `run_collect failed`，非法 `mode` 同样 fail-closed。

compact 输出在 full 全部安全 base 字段之外，仅 compact 额外返回：`view`（恒 `"compact"`）、`compactStatus`、`assistantMessageCount`（形状与出现条件见生成层），以及 MCP 面仅在 `too_large` 态出现的 `compactFallback`（见下）。

`compactStatus` 为闭集三态：

- `available`：≥1 条 assistant 文本，且最后一条 ≤4000 字符 → `messages` 恰好一条完整原样文本，`truncated:false`。
- `empty`：无 assistant 文本 → `messages:[]`。
- `too_large`：最后一条 >4000 字符 → `messages:[]`，不给部分文本、不给 cursor。需要全文时省略 `mode`（即 full）分页读取。MCP 面此时额外携带 `compactFallback`：静态指引文本，`content` JSON 与 `structuredContent` 同体，点名去掉 `mode=compact` 改用 `mode=full`、沿 `nextCursor` 跨页续读、并给出 `continuation` 机械重组规则；`available`/`empty`/full 输出不携带该字段。
- 三态均为 `truncated:false`、`nextCursor:null`。

`assistantMessageCount` 是完整快照中 assistant 文本条数；它与 `evidenceCounts.message`（所有 message 形状条目，含 user）不同。compact 不是摘要、不是 final-answer 决策，也不替代 full 续读。审计遵循上文"审计追加时机"：成功恰好一条，任何失败零条。

### CLI 对等

- `wao collect <runId>`：默认 raw ops 输出，含完整 `data` 数组（供 ops/人读）；`--limit N` 是尾部截取语义，`--limit 0` = 全部。
- 机器可读的续读入口：`wao collect <runId> --format json`（首页）和 `wao collect <runId> --cursor <token> --format json`（续读页）。两者输出结构（messages/evidenceCounts/itemCount/truncated/nextCursor）与 MCP `structuredContent` 深度语义一致。
- `wao collect <runId> --mode compact` 进入与 MCP 相同的 compact 投影（`--mode compact --format json` 等价；`--mode` 单独即触发投影模式）；`--mode full` 与 `--format json` 兼容。
- 投影模式是 strict parser：`--cursor`/`--format`/`--mode` 缺值或空值在读取 transcript 前即拒绝，不静默退回 raw collect；`--limit` 在投影模式被拒绝（pagination 由投影层固定，用户 limit 会与之冲突）；未知 flag、重复 flag、多余 positional 均拒绝；`--mode` 非法值（非 `full`/`compact`）与 `--mode compact --cursor` 同样在读前拒绝。

### CLI `--final`：最终答复一屏出口

`npm run cli -- collect <runId> --final` 复用与 MCP compact 完全相同的投影/脱敏/消毒路径（无第二解析器），把最后一条 assistant 文本按四态渲染到 stdout，适合脚本或流水线直接取最终答复：

- `available`（最后一条 assistant 文本 ≤4000 字符）→ stdout 恰为消毒后的最终 assistant 文本（secret redaction + C0/C1/DEL 清洗之后，不承诺逐字节等于原文），exit 0。
- `empty`（无 assistant 文本）→ 固定标记 `[final: no assistant message]`，exit 0。
- `too_large`（最后一条 >4000 字符）→ stdout 是一行固定指引（不给部分文本、不给 cursor），exit 0。加 `--out FILE` 把最终回答写进文件：写的是脱敏与控制字符清理之后的完整文本，单条消息不超过一百万字符（超过则报固定文案、不写文件）；或去掉 `--final`，用 `--format json` 分页读（同一条消息的切片首尾相接，`truncated:false` 的切片是这条消息的末尾，跟着 `nextCursor` 翻页）。

`--final` 是布尔 flag（不接受值），与 `--cursor` 互斥（沿用 compact 的既有互斥拒绝，非零退出）；与 `--format json`/`--mode` 同用时由 `--final` 的四态渲染接管输出；`--out` 只与 `--final` 同用。审计与 collect 相同：成功调用追加恰好一条 `messages.collected`（`--final` 不豁免——collect 本就非只读），任何失败零追加。

## MCP `run_diagnose`：诊断失败原因

`run_diagnose` 让 MCP host 诊断一个 run 的失败原因分类。它与 CLI `runs diagnose` 共用同一 application service，不 shell-out CLI。只读：不追加 transcript event、不修改 terminal state、不给处方或建议。

输入只接受 `runId`；`runDir`/`raw`/`includeEvidence`/`recommend`/`retry`/`worker`/`strategy` 等是 server-owned，模型不能传。参数与形状见 [docs/surface/mcp-tools.md](../surface/mcp-tools.md)。

`category` 是闭集 enum，含 `provider_capacity` 与 delivery worktree 越界的 `workdir_escape`。`signalEventTypes` 只保留 evidence 的 event type：最多 8 条，每条 ≤64 字符，异常映射为 `unknown`。绝不返回 raw fact/error/detail/reason/check name/command/tool payload/path/timestamp/prompt/PID/sessionId/provider stderr/环境变量，也绝不返回 recommendation/advice/retry/nextStep。失败返回固定 `run_diagnose failed`。

诊断码 `code` 是可空闭集字段，按类别配对校验：

- `provider_auth` → `subscription_access_disabled` / `organization_policy_denied` / `api_key_missing` / `unauthorized` / `invalid_credential`
- `provider_capacity` → `rate_limited` / `quota_exhausted`
- `no_effect` → `completed_empty`
- 其余类别恒为 `null`；非法、越集或错配的（类别, 码）组合折叠为 `null`。

`provider_capacity` 只从 failed 终态的持久 `run.error` 分类；非终态 runtime 的 `rate_limit_event` 不会被升级为失败。所有 code 都是安全事实标签，永不回显原始错误文本/path/command/key/payload。WAO 不根据这些事实自动重试、换 worker 或停止其他 run——处置归 Lead。CLI `runs diagnose` 显示同一 category 与 code。

空转完成（`category=no_effect`，线路 `code=completed_empty`）：进程 exit 0 / parser `done(completed)` 只是传输完成，不是 worker 产出可用结果的证据。一个 completed run 若仅有传输层活动（runtime init/streaming、thinking、zero-usage metrics）而无任何可用产出（非空 assistant 文本、命令活动、文件写入、tool_use/tool_result），判为 `no_effect` + 事实码 `completed_empty`。`run_diagnose` 与 `run_await_result` 都把 `category=no_effect` 与 `code=completed_empty` 同时透出到 wire——`completed_empty` 是可机读的"空转完成"事实。failed 的 run 即使空转，code 恒为 `null`；正常 completed 仍 `category=none` / `code=null`；有效的 tool-only / command-only / file-written 完成仍判 `none`。`completed_empty` 只命名这条机器真相，永不回显 provider 原文/argv/path/prompt/secret。

配套的 parser 行为：claude-code 在成功 result 事件含非空 `result.result`、且此前未流式输出过相同 assistant 文本时，会补发恰好一条 assistant 消息再 done，避免 resume 场景的最终答案丢失；已流式输出相同文本则不重复。

## `availableDrilldowns`：结果自带的下钻提示

`run_wait`、`run_await_result`、`run_status`、`run_diagnose`、`run_collect`、`run_delivery`、`run_activity` 七个工具的输出统一携带（schema REQUIRED）`availableDrilldowns`：≤4 条静态披露元数据，告诉 Lead 哪个安全观察工具可以揭示更多、以什么深度、多大代价。只披露，不自动调用，不做任何语义决策。运行中的 `run_wait` 直接提示 `run_activity`；终态成功提示 activity + compact result；终态失败提示 diagnosis + activity。目的：省 Lead 的 token 与注意力，判断、停止与后续工具选择完全留给 Lead。

每条 entry 是严格七键对象：

- `tool` ∈ 闭集 `run_status | run_activity | run_collect | run_delivery | run_delivery_review | run_diagnose`（观察类闭集，永不出现 `run_stop`/`run_continue`/`run_dispatch`/`run_delivery_decide` 等控制或变更工具）。
- `view` ∈ 闭集 `compact | timeline | evidence | delivery | diagnosis`（深度由浅到深：compact 最后一助手文本 → timeline 活动时间线一页 → evidence 一页有界 worker 输出 → delivery 交付事实 → diagnosis 故障诊断）。
- `detail` = 一行深度短语；`purpose` = Lead 为何可能想看它；`reveals` = 展开后能看到的额外事实（均为字段/文本级的既有安全输出，无新内容）。
- `cost` ∈ 闭集 `low | medium | high`：`low` 单次快照读取；`medium` 分页或较大输出；`high` 完整 delivery diff 审阅。
- `readOnly` 按被披露工具如实标注：`run_collect` 每次成功调用追加一条 `messages.collected` 审计，其三条 entry 报 `readOnly:false`；其余五个可披露工具零 append，报 `readOnly:true`。

每个工具的输出都基于已返回的机器事实选择披露：不推断、不给处方、不选文件、不遍历 cursor；内容全是 WAO 代码选定的静态字符串，不含 transcript/provider/仓库文本。上限（≤4 条、序列化 ≤2048 字节、字段 ≤160 字符）由共享模块硬性强制，≤4 条同时反映到 schema `maxItems`。代表性披露：

- `run_await_result` 终态 compact 可用 → `run_activity`（timeline，medium）+ `run_collect`（evidence，medium）；`too_large` → `run_collect` 优先；非终态 / 静默 / read_failure → `run_status`（timeline，low）+ `run_activity`。
- `run_status` 失败终态 → `run_diagnose`（diagnosis，low）+ `run_activity`；completed → `run_activity` + `run_collect` compact（low）。
- `run_diagnose` 类别 `delivery_packaging_failed` → `run_delivery`（delivery，low）+ `run_activity`；其它失败类别 → `run_activity` + `run_collect` compact。
- `run_collect` compact 可用 → `run_collect` full（evidence，medium）+ `run_activity`；full 带 `nextCursor` → 续页 + `run_activity`；单页读完 → `run_activity`。
- `run_delivery` reviewable（verification 已有终态结果）→ `run_delivery_review`（delivery diff，high）+ `run_activity`；packaging failure / `deliveryFailure.code` → `run_activity` + `run_diagnose`；`isolation_failed` / `isolationFailure.code`（含 `workdir_escape`）→ `run_activity` + `run_diagnose`，不外广告 `run_delivery_review`；未请求 delivery → `run_activity` + `run_status`。readiness 等待路径与 point-in-time 路径披露一致；point-in-time 即使不携带 `readiness`，也由已安全投影的 `isolationFailure.code:"workdir_escape"` 驱动同一语义，未知 code 不提升。
- `run_activity` 有 `nextCursor` → 同工具续页；终态读完 → `run_collect` compact；非终态 → `run_status`。

该字段是加法字段：既有输出字段、行为、audit 语义不变；Lead 可以忽略它，直接用原子工具。`run_delivery_review_bundle` 的输出不携带该字段——其嵌套 `delivery` 保持既有合同，只有 standalone `run_delivery` 带。

## MCP `runs_list`：列出 run

`runs_list` 让 MCP host 列出当前绑定范围内的 run。只读、幂等：不修改任何持久状态、不追加 transcript event。workspace 未绑定时返回空 `runs:[]`，不 fail-closed——这是只读列举，不是 state-changing 操作；其它项目的 run 不可见，不跨 workspace 探测。

输入两字段均可选。`activeOnly`（bool，默认 `false`）：只返回经证明 active 的 run——transcript 为已知非终态且有 fresh owner heartbeat（默认 10s 阈值）。单纯"未到终态"不足以算 active：一个非终态但缺 fresh heartbeat 的 run 不在 `activeOnly` 结果里，但也绝不据此推断它 failed/dead/stopped（仍可能长时间运行或休眠）；它计入 `unresolvedCount`，仍出现在普通（非 `activeOnly`）列表中。`limit`（整数 1..100，默认 `50`）：返回条目数上限。`runDir`、registry、`agentId`、`cwd`、`workspaceRoot` 等 server-owned——绑定由 server 解析，不能通过 tool argument 提供。

`runs` 每个元素含 `runId`/`agentId`/`state`/`terminal`/`updatedAt` 和两个活动投影字段：

- `activityStatus` ∈ `terminal | active | unresolved | unknown`
- `activityBasis` ∈ `terminal_state | fresh_owner_heartbeat | no_fresh_owner_heartbeat | unknown_state`

`active` 要求已知非终态 + fresh owner heartbeat；`unresolved` = 非终态但无 fresh heartbeat；终态与无法识别的 state 永不为 `active`。`returnedCount` = `runs.length`；`truncated` 表示因 `limit` 截断而仍有更多匹配 run；`unresolvedCount` = 全量扫描中已知非终态但缺 fresh heartbeat 的 run 数（在 `limit` 之前计数，与 `activeOnly` 无关），`lead_preflight` 复用它而无需重新扫描。

每行的 `state`/`terminal`/`updatedAt` 只由本 run 自身信封事件计算（文件名即权威 runId）；MCP 查询缓存路径与 CLI 直读路径同语义。全无信封的旧 transcript 保持既有读法；任一事件带信封即严格绑定；零绑定事件（整份只有外 run 信封行）降级 pending / `updatedAt:null`——宁可可见地缺事实。`agentId` 由 events[0] 派生（append-only 首写不变量）。

一次 `runs_list` / `lead_preflight` 查询先证明授权 workspace，再按查询范围缓存每个不同 ownership cwd 的 Git 顶层证明（包括 fail-closed 的不可证明结果）；不为同一项目的每个历史 run 重复启动 Git 证明进程。缓存只活在单次查询内，不跨调用持久化，也不改变 workspace 隔离、过滤或错误投影。

绝不返回：PID、进程路径、session id、argv、command、绝对路径、prompt、环境变量、messages、evidence、异常 message/stack。失败返回固定安全文案 `runs_list failed`。

CLI fallback：`npm run cli -- runs list [--agent ID] [--latest N]`。

## MCP resources `wao://playbooks`：Lead Playbook Catalog

内置 Lead Playbook Catalog 通过 MCP resources 暴露，是一个小型只读决策脚手架：一个 playbook 给 Lead 紧凑的默认值、证据门和适应点；Lead 可保留、跳过或修改任何条件步骤。不要求每次派发前读取，偏离 playbook 无需 Owner 批准（除非既有权威规则已要求）。Catalog 不自动拆解任务、不选 worker、不派发、不推进 phase、不验收；不存在 `playbook_run`/`playbook_start`/`playbook_next`/`playbook_recommend` 工具。

两个只读 resources（`resources/read`，mimeType `application/json`）：

```
wao://playbooks              → { playbooks: [{ id, version, title, summary, lanePattern }] }   // summary，恰好四个内置 playbook，稳定顺序
wao://playbooks/{id}         → { playbook: <完整 PlaybookV1> }   // 详情：roles/phases/completionEvidence/escalation
```

`resources/list` 返回 summary resource + 四个已知 id 的 detail resource（`wao://playbooks/<id>`）；`resources/templates/list` 返回 `wao://playbooks/{id}` 模板。读取委托同一 catalog service。不要求 workspace binding，不读 transcript/registry/runDir，不产生任何 transcript 或文件副作用。未知 id 与 service 失败折叠为固定安全错误——`playbook summary failed`（summary resource）/ `playbook detail failed`（detail resource，含未知 id）——不回显 id、路径或 catalog 原始内容；唯一例外是协议要求回显 caller 提供的 `uri`。

四个内置 playbook：

| id | 默认模式 |
|---|---|
| `single-coder-delivery` | 一个 bounded coder lane，frozen verification |
| `parallel-independent-deliveries` | 两个以上不重叠 lane，composition gate |
| `investigate-then-implement` | 先只读调查，Lead 综合，再派 coder |
| `read-only-independent-review` | 独立只读审查 |

CLI fallback（`npm run cli --`）：

```
npm run cli -- playbook list                    # id<TAB>lanePattern<TAB>title<TAB>summary
npm run cli -- playbook list --format json      # { playbooks: [ {id,version,title,summary,lanePattern} ] }
npm run cli -- playbook show <id>               # 完整 PlaybookV1 pretty JSON
npm run cli -- playbook show <id> --format json # { playbook: { ...完整 PlaybookV1... } }
```

CLI 只做 argv/format/console，数据逻辑与 MCP resource 委托同一 service，因此 CLI `--format json` 与 MCP resource content 语义精确一致。unknown/malformed id 透传固定 typed error（`PlaybookNotFoundError`/`PlaybookValidationError`），不输出 raw catalog/path。

## `semanticNotes` 与 resources `wao://semantics`

恰好四个 standalone 只读成功结果——`run_wait`/`run_await_result`/`run_delivery`/`run_diagnose`——携带 REQUIRED `semanticNotes`（1..4 条）。每条恰好三键 `{ id, meaning, doesNotMean }`：`id` 是冻结的 namespaced 闭集值（`observation.*`/`termination.*`/`delivery.*`/`diagnosis.*`）；`meaning` 是一句确定性事实；`doesNotMean` 是 0..2 条确定性非含义。没有 `scope` 字段、没有 per-entry `semanticsRef`；详情 URI 机械派生 `wao://semantics/{id}`。

notes 完全由既有机器事实决定（observation outcome / termination source、diagnosis category、delivery readiness / verification status），由单一选择器挑出：永不回显 transcript/provider/path/prompt/command/session，永不建议 accept/reject/repackage/stop/retry/dispatch。关键不变量：`observation.read_failure` 不产生任何终止 note；delivery note 明确 verification passed 不是 Lead acceptance；diagnosis note 只陈述事实、不给处方。`run_delivery_review_bundle` 嵌入的 nested delivery 不含 `semanticNotes`。

两个只读 resources（`resources/read`，mimeType `application/json`）：

```
wao://semantics            → { semantics: [{ id, meaning }] }                 // summary：每个 id + meaning（无 doesNotMean）
wao://semantics/{id}       → { note: { id, meaning, doesNotMean } }           // 详情：单条完整 note
```

`resources/list` 返回 summary resource（`wao://semantics`）；`resources/templates/list` 返回 `wao://semantics/{id}` 模板；不把每个 detail id 注册为独立静态 resource。读取委托同一 SSOT。未知/畸形 id 与 service 失败折叠为固定安全文本——`semantics summary failed`（summary）/ `semantics detail failed`（detail，含未知 id）——不回显请求 id 或目录原始内容；唯一例外是协议要求回显 caller 提供的 `uri`。
