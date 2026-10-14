# 取结果与查历史

> [使用手册](../usage.md)的一页：取回 worker 的回答、诊断 run、用脚本消费 JSON 输出、列出与统计 run。

## 场景 6：查看指标

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

**R18 报表读绑定（TD-128 W1，2026-08-18）**：`runs metrics <runId>` 与 `runs scorecard <runId>` 的事实读取（state/tokens/cost/duration/scorecard 与 reason）是 **runId 绑定** 的（单一定义处 `src/metrics.js` 的 `boundReportScope`）——尾部追加的外 run/伪造行不再污染报表值；两命令的 `runId` 在拼接 transcript 路径前过 `isValidRunId`（delivery.js SSOT，与 `loadRun` 同款拒绝文案，不回显输入）。全无信封的 legacy transcript（pre-envelope）保持既有读法照常出报表——合法路径与既有输出零变化。`run` 前台命令汇总的 scorecard 段与 `npm run smoke` 的 scorecard 判定同款绑定。`runs metrics --summary` 的逐文件聚合自 R19（TD-128，2026-08-18）起同款绑定（文件名 stem 即权威 runId，逐文件传入绑定读者）——合法路径与既有输出零变化。

## 被脚本/LLM 驱动

本工具的设计目标之一是**可被任何调用方平等驱动**（bash 脚本、LLM 编排器、CI）。

**脚本化消费 JSON 的规程（TD-153a）**：一律用全局 `wao` 命令（天生免疫 npm 噪声）或 `npm run --silent cli --`。裸 `npm run cli --` 会让 npm 在 stdout 打 banner，污染 JSON 输出——只适合人读交互，不要进脚本/管道。

`--format json` **不是全局开关**，支持面以命令为准（TD-153e 起如实陈述，本处不维护全量清单）：

- **恒为 JSON、无需 flag**：`spawn`（含 runId + transcript 路径）；`status`（无 `--format` 分支——flag 是 no-op，被接受但不改变任何行为，输出恒 JSON）；裸 `collect <runId>`（raw ops JSON）。
- **`--format json` 显式开启**：`run`（JSON 输出含 messages + metrics）；TD-86 起的查询族（registry validate / registry check / runs list / runs summary / runs grep / wao decision list / wao handoff read，形状见下）；runs 族多数子命令（wait / gate / metrics / scorecard / diagnose / dashboard / delivery）。
- **已知例外**：`collect --final` 接受 `--format json` 但 stdout 恒为四态文本，不输出 JSON 信封（TD-153b 起该组合 stderr 警告一次）——机器可读请去掉 `--final` 用分页 `collect <runId> --format json`。

```powershell
# spawn 返回 JSON（含 runId + transcript 路径）
npm run --silent cli -- spawn glm-flash --prompt "..." | ConvertFrom-Json

# run 的 JSON 输出含 messages + metrics
npm run --silent cli -- run glm-flash --prompt "..." --format json | ConvertFrom-Json

# 查询族：registry / runs / wao 的只读子命令（TD-86 起同样支持 --format json）
npm run --silent cli -- registry validate --registry config/agents.json --format json
npm run --silent cli -- registry check --registry config/agents.json --format json
npm run --silent cli -- runs list --format json
npm run --silent cli -- runs summary --format json
npm run --silent cli -- runs grep "error" --format json
npm run --silent cli -- wao decision list --format json
npm run --silent cli -- wao handoff read lead --format json
```

> 本区为**手写参考**（不可从代码推导——形状散在各命令实现中，无单一输出形状 SSOT；未来若出现输出形状 SSOT 可转生成层，届时登记 tech-debt）。内容为契约，修改需过 docs-consistency。

TD-86 起上述 7 个查询子命令的 JSON 输出形状（字段全部来自既有计算结果）：

- `registry validate --format json` → `{checked, valid, agents:[{id, ok, issues[], warnings[]}]}`；JSON 模式维持 exit code 契约（有错误条目 → exit 1，文本模式的 ⚠ warning 进入 `warnings[]`，不阻塞）。registry 源 JSON 解析失败时输出 `{checked:0, valid:false, agents:[], issues:[...]}`——顶层 `issues` 数组保留原始解析错误 message，exit 1。文本模式：角色合同失败的 agent 只输出一行 `✖ <id>`（不先打 ✔ 成功行再打 ✖ 自相矛盾两行）。
- `registry check --format json` → `{allOk, agents:[{id, status:"ok"|"fail"|"skip", serveUrl?, error?}]}`；fail 会照旧 exit 1。
- `runs list --format json` → 直接序列化共享 `listRuns` 服务结果（`{runs:[{runId, agentId, state, terminal, updatedAt, ...}], matchedCount}`），零新计算。
- `runs summary --format json` → `{total, byState, latest}`（无事件时间戳时 `latest:null`）。
- `runs grep <pattern> --format json` → `{pattern, matched, matches:[{runId, type, ts}]}`——与文本路径一致，**每个 run 只记录首个命中事件**（不是全量命中清单）。
- `wao decision list --format json` → `{decisions: string[]}`（map.md 索引行原样包装，不做 id/title 解析）。
- `wao handoff read <role> --format json` → 找到时 `{found:true, role, body}`；未找到时维持既有 `{found:false}`。

LLM 编排器（未来的 M5 DAG 或外部脚本）只需要：
1. `spawn` 启动 run，拿 runId
2. `status <runId>` 轮询状态
3. `collect <runId>` 或读 transcript 拿产出
4. `runs metrics <runId>` 拿成本

## MCP `run_collect`（有界结果收集，M9-4B）

`run_collect` 让 MCP host 收集一个 run 的 worker 产出。它直接复用与 CLI `collect` 相同的 application service（`collectRunMessages()`），不 shell-out CLI。**不是只读**：每次成功调用追加一个 `messages.collected` 审计事件到 transcript（不改变 terminal state）；重复调用会再次追加（非幂等）。

`run_collect` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。`cursor` 是可选的 opaque continuation token（仅 full 模式可带，值来自上一页的 `nextCursor`）；`mode` 可选（`full|compact`，省略 ≡ `full`）。`runDir`、`limit`、`serveUrl`、`sessionId`、`raw`、`includeTools` 等是 server-owned 配置，模型不能传。安全有界输出只返回 assistant 文本 + 证据计数，不含原始执行证据。

**M11-8B canonical worker identity**：`agentId` 是 transcript envelope 盖戳的 canonical worker 身份——Lead 据此确认实际 worker，**不解析 worker 自由文本**（worker 可能自报 `/root`、`Coder-HQ`、显示名或完全不报，都不改变 durable `agentId`）。缺失/冲突降级为 `"unknown"`，不抛错、不伪造身份、不是自动停止门。`agentId` 来自 collect 已读的同一份 transcript 快照，不额外读 transcript/registry/文件系统。

**R16 读绑定（TD-127/TD-128 收口，2026-08-18）**：collect 的两处会话事实读取是 **runId 绑定** 的（与 retry/resume/stop/correction 等 lane 同一 `transcript.js` 绑定读取器纪律）：`session.created` 取**末条绑定**（serveUrl/sessionId 是 serve 取回的整体重定向面，末条序与 stop/activity 同族），`run.started` 取**首条绑定**（派发时稳定事实——R12-C/R14-C 首条纪律；合法 transcript 至多一条 `run.started`，首/末取法只在伪造尾条上分叉，首条=尾条伪造永不生效）。尾部追加的外 run 伪造行（错误信封 `runId`）对 collect 不可见，也不能重定向 serve 取回的 serveUrl/sessionId/directory 参数。**行为变更（Owner 2026-08-18 拍板不兼容信封前老数据；本机实测存量 pre-envelope transcript 为 0）**：旧格式 transcript 的 serve 取回自 R16 起降级为**无会话元数据拒绝**——`session.created` 行无 `runId` 字段（pre-envelope）时，collect 以固定 `Run <runId> has no session metadata` 拒绝（零 serve fetch、零 audit append、不伪造参数），与 stop 面对同形状的处置一致；`run.started` 缺绑定行时 serve 取回**不携带** directory 参数（serve 侧默认目录——绝不采用无法归属的 cwd，也不伪造新值）。

**R21 内容绑定（TD-128 W2 升格修复，2026-08-19）**：process 路径的**重建条目**自 R21 起只重建本 run 信封绑定的 `run.event`——`run_collect`（full/compact）与 `run_await_result` 的 compact 结果共用同一重建 SSOT（`reconstructItemsFromEvents`，调用侧收窄、函数本体不动），尾部追加的外 run/伪造行不再被重建进输出（messages/evidenceCounts/itemCount 等机器消费字段不含不可归属内容）。合法全绑定 transcript 上过滤器恒等（输出零变化）。collect 侧无 legacy 腿（上游会话门已拒全无信封形状）；`run_await_result` compact 侧全无信封 → 绑定后重建为空（该形状经终态门后不可达，纵深防御）。上文"外 run 伪造行对 collect 不可见"自此覆盖**会话事实与重建内容**两面。

边界：最多 8 条 message，每条 text 最多 4000 字符，全部 text 合计最多 12000 字符。**TD-119（2026-08-15，已成文契约变更而非纯 bug 修复）**：页级 `truncated:true` 仅表示"有内容被扣留待续读"（必伴 `nextCursor`）；entry 超 4000 字符设**该 entry 的** `truncated:true`（切片标记，语义见下文"单页内分块交付"）。旧的页级语义（任何超限——含 entry 切片——都设页级 `truncated:true`）已废弃：它使无损分块交付被误读为不可恢复的数据丢失（2026-08-15 Lead 三次实证）。只提取 assistant 角色 message 的 text part；assistant 文本经 secret redactor 脱敏当前进程环境中的凭据值。`messages:[]` 在无 assistant message 时是合法结果。

**M11-4 续读（continuation）**：当一次 collect 的结果超过单页边界（8 条 message、4000 字符/条、或 12000 字符总 cap），输出携带 `nextCursor: <opaque token>` 而非 `null`。Lead 用同一工具传 `{runId, cursor}` 继续读取下一页，直到 `nextCursor === null`。跨页拼接后完整、按序、无漏项、无重复；长单条 message 会在页内中途切分，下页从同一 message 的字符偏移继续；Unicode/CJK/emoji 不会在页边界拆坏 code point。**单页内分块交付（TD-119 语义修正）**：一条长消息若整条在单页预算内（≤12000 字符），会切成多条 ≤4000 字符的 entry 在**同一页一次性交付——该消息的 entry 按序拼接即全文**，`nextCursor:null`；页级 `truncated:true` 只在确有内容被扣留待续读时出现（必伴 `nextCursor`），不再把"切片交付但已完整"误报为 true；entry 级 `truncated:true` 仅表示该条目是切片。**消息边界规则（TD-224，2026-10-08 起有机械标记）**：切片 entry 若非源消息的开头（同消息的后继切片，或跨页游标恢复后的页首切片），携带 `continuation:true`；消息开头/完整的 entry **不携带**该字段（缺席 ≡ 消息开头，投影层从不发射 `false`——compact entry 形状因此不变）。机械重组：`continuation:true` 的 entry 文本拼接到前一 entry 之后，无该字段的 entry 开启新消息（跨页续读时，续读页首条带该标记即续接上一页末条）；entry 级 `truncated:false` 收尾一条完整消息的规则（TD-119）仍成立，机械重组以 `continuation` 标记为准——多条消息落在同一页时按此切分（勿把整页 entry 盲拼成一条）；跨页续读时，同一消息的切片按序拼接。cursor 是 server-opaque 的 base64url token（≤192 字符），只含 runId 摘要 + snapshot 摘要 + 位置索引，**绝不**含 raw runId/sessionId/path/prompt/secret 或任何 worker 文本；跨 run、跨 snapshot、跨位置重放都会 fail-closed 为固定 `run_collect failed`。cursor 是纯数据，Host/MCP 进程重启后仍可续读（无进程内 session 状态）。snapshot 在首次 collect 时冻结**完整 worker-authored raw 证据序列**（所有 message/command/tool_use/tool_result/file_written 事件，不只 assistant 文本）：若 worker 在分页期间继续追加 `run.event`，续读只读取冻结前缀，`itemCount`/`evidenceCounts` 与第一页完全一致（不漂移），不重复也不跳页；篡改历史事件（非追加）会 fail-closed。投影模式（MCP 总是；CLI `--format json`/`--cursor`）读取**完整** snapshot——不会在分页前截断为 50 条（pre-truncation 会永久隐藏早期消息）；legacy raw CLI `collect <runId>` 保持 `slice(-limit)` tail 行为不变。serve 后端的 `/message` endpoint 本身支持上游分页（`before` 游标 / `X-Next-Cursor`），但 WAO 当前的 `OpenCodeServeBackend.messages` adapter 选择单次 bounded `limit` 请求，**不消费上游分页能力**。投影模式用 cap+1 sentinel（10001）探测：返回 ≥ sentinel 条说明 run 超出当前 adapter 的安全容量（10000），**立即 fail-closed** 为固定 `run_collect failed`（零 partial、零 audit append），绝不把"只拿到 serve 尾部"谎报为"完整读完"。这是 WAO 当前 adapter 的有界策略，不是声称 OpenCode 不支持分页；未来 adapter 可消费上游分页以提升容量，但 M11-4 不实现该增强。process 与 serve 共用同一分页合同（算法 shape-driven，不按 runtime 名分支）。

**绝不返回**：command string/argv、tool input/tool output/tool result raw payload、file_written path、cwd、serveUrl、sessionId、PID、unknown event raw object、prompt、环境变量、异常 message/stack。`content` JSON 与 `structuredContent` 语义一致。service/投影/redaction/output validation 全部包在同一错误边界内；任何失败只返回固定 `run_collect failed`，不泄漏 SDK output validation error、原始异常、绝对路径或 secret。**任何**投影/schema 失败——包括 invalid cursor、cursor-less 第一页 service 成功但 projection 失败、output validation 失败——都**零追加** audit event。投影模式从第一页起一律 defer append，projection + output validation 全成功后才追加一次（M11-4）。

安全边界（对应生成层 annotations）：成功调用追加审计事件；serve path 可能读取外部 runtime 服务；但不杀进程、不修改 worker checkout、不改变 run terminal。

**CLI 续读对等**：默认 `wao collect <runId>` 保持原 raw ops 输出（含完整 `data` 数组，供 ops/人读），并继续接受 `--limit N`（legacy tail 语义，`--limit 0` = 全部）。机器可读的续读入口是 `wao collect <runId> --format json`（首页）和 `wao collect <runId> --cursor <token> --format json`（续读页）；两者委托与 MCP 相同的 `projectCollectResult`，输出结构（messages/evidenceCounts/itemCount/truncated/nextCursor）与 MCP `structuredContent` 深度语义一致。投影模式是 strict parser：`--cursor`/`--format` 缺值或空值在读取 transcript 前即拒绝（不静默退回 raw collect）；`--limit` 在投影模式被拒绝（pagination 由投影层固定，用户 limit 会与之冲突）；未知 flag、重复 flag、多余 positional 均拒绝。投影模式从第一页起 defer audit append，projection + output validation 全成功后才追加一次。

**M12-2A compact 模式**：可选输入 `mode` ∈ `{full, compact}`（省略 ≡ `full`）。`compact` 在**一次调用**内返回最后一条 assistant 文本（经与 full 完全相同的 redaction + C0/C1/DEL sanitization 后的原样文本，≤4000 字符）以及来自**同一份完整安全快照**的 `evidenceCounts`/`itemCount`——让 Lead 在终态后通常只需一次 collect 即可看到 worker 的最后结论与完整证据计数，而非 6-9 页 full 收集。compact **复用** full 的 `extractAssistantTexts`/脱敏/sanitization/`evidenceCounts` SSOT（不复制解析算法、**不做语义摘要**、**不决定**是否需要 full 输出）。compact **不接受 cursor**（cursor 仅 full 可带）；`compact+cursor` 在 service/read/append 之前 fail-closed 为固定 `run_collect failed`，非法 `mode` 同样 fail-closed。compact 输出在 full 全部安全 base 字段之外，**仅 compact** 额外返回：`view`（恒 `"compact"`）、`compactStatus`、`assistantMessageCount`（形状与出现条件见生成层），以及 TD-224 起仅在 `too_large` 态出现的 `compactFallback`（降级指引，见下文三态）。

`compactStatus` 为闭集三态：`available`（≥1 条 assistant 文本，且最后一条 ≤4000 字符 → `messages` 恰好一条完整原样文本，`truncated:false`）；`empty`（无 assistant 文本 → `messages:[]`）；`too_large`（最后一条 >4000 字符 → `messages:[]`，**不**给部分文本、**不**给 cursor——需要全文时用 full 模式（默认）分页读取：长消息按 ≤4000 字符 entry 无损分块交付，语义见上文 TD-119；MCP 消费者直接省略 `mode` 即为 full。TD-224 起，MCP 面 `too_large` 结果额外携带 `compactFallback`——静态指引文本，`content` JSON 与 `structuredContent` 同体，点名去掉 `mode=compact` 改用 `mode=full`、沿 `nextCursor` 跨页续读、并给出 `continuation` 机械重组规则；`available`/`empty`/full 输出不携带该字段）。三态均为 `truncated:false`、`nextCursor:null`；`assistantMessageCount` = 完整快照中 assistant 文本条数（注意它与 `evidenceCounts.message`——所有 message-shape 条目含 user——不同）。每个 compact **成功**严格追加**一个** `messages.collected`；任何 input/投影/schema/service 失败（含 `compact+cursor`、非法 `mode`、serve sentinel ≥10001）追加**零**个（投影模式 defer append，projection + output validation 全成功后才提交）。compact 不是摘要、不是 final-answer 决策，也不替代 full 续读。

**CLI compact 对等**：`wao collect <runId> --mode compact` 进入与 MCP 相同的 compact 投影（`--mode compact --format json` 等价；`--mode` 单独即触发投影模式）。`--mode full` 与现有 `--format json` 机器投影兼容。strict parser：`--mode` 缺值、非法值（非 `full`/`compact`）、`--mode compact --cursor`、未知 flag、重复 flag 均在读取 transcript 前拒绝；默认 raw `wao collect <runId>` 保持不变。

**CLI `--final`（最终答复一屏出口，TD-112）**：`npm run cli -- collect <runId> --final` 复用与 MCP compact 完全相同的投影/脱敏/消毒路径（同一 `projectCollectResult`，无第二解析器），把**最后一条 assistant 文本**按四态渲染到 stdout，适合脚本/流水线直接取最终答复：

- `available`（最后一条 assistant 文本 ≤4000 字符）→ stdout 恰为**消毒后**的最终 assistant 文本（secret redaction + C0/C1/DEL 清洗之后，不承诺逐字节等于原文），exit 0；
- `empty`（无 assistant 文本）→ 固定标记 `[final: no assistant message]`，exit 0；
- `too_large`（最后一条 >4000 字符）→ stdout 是一行固定指引（不给部分文本、不给 cursor），exit 0。加 `--out FILE` 把最终回答写进文件：写的是脱敏与控制字符清理之后的完整文本，单条消息不超过一百万字符（超过则报固定文案、不写文件）；或去掉 `--final`，用 `--format json` 分页读（同一条消息的切片首尾相接，`truncated:false` 的切片是这条消息的末尾，跟着 `nextCursor` 翻页）。

`--final` 是布尔 flag（不接受值），与 `--cursor` 互斥（沿用 compact 的既有互斥拒绝，非零退出）；`--final` 与 `--format json`/`--mode` 同用时由 `--final` 的四态渲染接管输出。成功调用与 collect 一致追加恰好一条 `messages.collected` 审计事件（`--final` 不豁免——collect 本就非只读）；任何输入/投影失败零追加。

## MCP `run_diagnose`（安全确定性诊断，M9-5B）

`run_diagnose` 让 MCP host 诊断一个 run 的失败原因分类。它直接复用与 CLI `runs diagnose` 相同的 application service（`getRunDiagnosis()` → `diagnoseFailure()` 内核），不 shell-out CLI。只读——不追加 transcript event、不修改 terminal state、不给处方或建议。

`run_diagnose` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入只接受 `runId`；runDir/raw/includeEvidence/recommend/retry/worker/strategy 等是 server-owned，模型不能传。安全输出只返回机器字段，不含 raw evidence fact。

`category` 来自 `DIAGNOSIS_CATEGORIES` SSOT（闭集 enum，含 `provider_capacity` 与 delivery worktree 越界的 `workdir_escape`）。`signalEventTypes` 只保留 evidence 的 event type（最多 8 条，每条 ≤64 字符，异常映射为 `unknown`），**绝不返回** raw fact/error/detail/reason/check name/command/tool payload/path/timestamp/prompt/PID/sessionId/provider stderr/环境变量，也**绝不返回** recommendation/advice/retry/nextStep。`content` JSON 与 `structuredContent` 语义一致。失败返回固定 `run_diagnose failed`。

**诊断码（`code`）**：可空闭集字段，取值属于单一通用 SSOT `DIAGNOSIS_CODES`（`src/diagnosis.js`，由 provider-auth、provider-capacity 与 no-effect 三组代码派生），并必须通过 `isValidDiagnosisCode(category, code)` 的**类别—码配对**校验：`provider_auth` 使用 `subscription_access_disabled` / `organization_policy_denied` / `api_key_missing` / `unauthorized` / `invalid_credential`；`provider_capacity` 使用 `rate_limited` / `quota_exhausted`；`no_effect` 使用 `completed_empty`（见下方 M12-21）；其余类别恒为 `null`。`provider_capacity` 只从 **failed 终态**的持久 `run.error` 分类，非终态 runtime `rate_limit_event` 不会被升级为失败。所有 code 都是安全事实标签，**永远不**回显原始错误文本/path/command/key/payload；非法/越集 code 或错配的（类别, 码）折叠为 `null`。WAO 不根据这些事实自动重试、换 worker 或停止其他 run，处置归 Lead。CLI `runs diagnose` 显示同一 category 与 code。

**M12-21 completed-empty 真相（`category=no_effect`，线路 `code=completed_empty`）**：进程 exit 0 / parser `done(completed)` 只是**传输完成**，不是 worker 产出可用结果的证据。一个 completed run 若仅有 transport 活动（runtime init/streaming、thinking、zero-usage metrics）而无任何可用产出（非空 assistant 文本、命令活动、文件写入、tool_use/tool_result），归类为 `no_effect` + 事实码 `completed_empty`（`src/diagnosis.js` 的 `NO_EFFECT_DIAGNOSIS_CODES`）。Lead 校正后**线路与内核统一**：MCP `run_diagnose` 与 `run_await_result` 都把 `category=no_effect` 与 `code=completed_empty` **同时**透出到 wire——`completed_empty` 是 Lead 可机读的"空转完成"事实，不再折叠为 `null`。线路 `code` 闭集由单一通用 SSOT `DIAGNOSIS_CODES` 约束，经 `isValidDiagnosisCode(category, code)` 配对校验：`no_effect`、`provider_auth`、`provider_capacity` 仅能携带各自代码，其余（含 **failed** 的 `no_effect` run）恒为 `null`；正常 completed 仍 `category=none` / `code=null`。`completed_empty` 只命名这条机器真相，**永不**回显 provider 原文/argv/path/prompt/secret。有效的 tool-only / command-only / file-written 完成仍判 `none`。配套：claude-code parser 在成功 result 事件含非空 `result.result`、且此前未流式输出过相同 assistant 文本时，会补发恰好一条 assistant 消息再 done，避免 resume 场景的最终答案丢失（已流式输出相同文本则不重复）。

## MCP `availableDrilldowns`（有界渐进式披露元数据，M12-8B）

`run_wait`、`run_await_result`、`run_status`、`run_diagnose`、`run_collect`、`run_delivery`、`run_activity` 七个工具的输出**统一携带（schema REQUIRED）** `availableDrilldowns`：**≤4 条静态披露元数据**（`readOnly` 按被披露工具如实标注），告诉 Lead 哪个安全观察工具可以揭示更多、以什么深度、多大代价——**只披露，不自动调用，不做任何语义决策**。运行中的 `run_wait` 直接提示 `run_activity`；终态成功提示 activity + compact result，终态失败提示 diagnosis + activity。它削减 Lead 的 token/注意力成本，同时把判断、停止与后续工具选择完全留给 Lead。

每条 entry 是严格七键对象：

- `tool` ∈ 闭集 `run_status | run_activity | run_collect | run_delivery | run_delivery_review | run_diagnose`（**观察类闭集**，永不出现 `run_stop`/`run_continue`/`run_dispatch`/`run_delivery_decide`/`run_delivery_repackage`/`run_delivery_reverify`/`workspace_select` 等 control/mutation 工具）。`readOnly` 是**按工具如实的布尔值**：`run_collect` 每次成功调用追加一条 `messages.collected` audit（与其 `readOnlyHint:false/idempotentHint:false` 一致），其三条 entry 报 `readOnly:false`；其余五个工具零 append，报 `readOnly:true`。
- `view` ∈ 闭集 `compact | timeline | evidence | delivery | diagnosis`（深度由浅到深：compact 最后一助手文本 → timeline 活动时间线一页 → evidence 一页有界 worker 输出 → delivery 交付事实 → diagnosis 故障诊断）。
- `detail` = 一行人性化深度短语；`purpose` = Lead 为何可能想看它；`reveals` = 展开后能看到哪些额外事实（均为字段/文本级别的既有安全输出，绝无新内容）。
- `cost` ∈ 闭集 `low | medium | high`——`low` 单次快照读取；`medium` 分页/较大输出；`high` 完整 delivery diff 审阅。

每个工具的输出都基于**已返回的机器事实**选择披露，不做推断、不给处方、不选文件、不遍历 cursor；内容全是 WAO 代码选定的静态字符串，绝不含 transcript/provider/仓库文本。上限（≤4 条、序列化 ≤2048 字节、字段 ≤160 字符）由共享模块 `src/application/runDrilldowns.js` 硬性强制（≤4 条同时反映到 schema `maxItems`；序列化字节上限仅由 selector 强制，schema 不 enforce 字节数），MCP schema 枚举/上限由同一模块导出派生。代表性披露：

- `run_await_result` 终态 compact 可用 → `run_activity`（timeline，medium）+ `run_collect`（evidence，medium）；`too_large` → `run_collect` 优先；非终态 / 静默 / read_failure → `run_status`（timeline，low）+ `run_activity`。
- `run_status` 失败终态 → `run_diagnose`（diagnosis，low）+ `run_activity`；completed → `run_activity` + `run_collect` compact（low）。
- `run_diagnose` 类别 `delivery_packaging_failed` → `run_delivery`（delivery，low）+ `run_activity`；其它失败类别 → `run_activity` + `run_collect` compact。
- `run_collect` compact 可用 → `run_collect` full（evidence，medium）+ `run_activity`；full 带 `nextCursor` → 续页 + `run_activity`；单页读完 → `run_activity`。
- `run_delivery` reviewable（verification 已有终态结果）→ `run_delivery_review`（delivery diff，high）+ `run_activity`；packaging failure / `deliveryFailure.code` → `run_activity` + `run_diagnose`；`isolation_failed` / `isolationFailure.code`（M12-13）→ `run_activity` + `run_diagnose`（无 packaging/diff/decision 面，不外广告 `run_delivery_review`）；未请求 → `run_activity` + `run_status`。waitMs readiness 路径与 point-in-time 路径披露一致；point-in-time 即使不携带 `readiness`，也会由已安全投影的 `isolationFailure.code:"workdir_escape"` 驱动同一语义，未知 code 不提升。
- `run_activity` 有 `nextCursor` → 同工具续页；终态读完 → `run_collect` compact；非终态 → `run_status`。

该字段是**加法字段**：既有输出字段、行为、audit 语义（只读工具零 append；`run_collect` 成功仍恰好一次 append）完全不变；Lead 完全可以忽略它，直接用原子工具。`run_delivery_review_bundle` 的输出**不**携带该字段——其嵌套 `delivery` 保持既有合同（只有 standalone `run_delivery` 带）。

## MCP `runs_list`（project-bound run 列表，M10 P0-3）

`runs_list` 让 MCP host 列出当前 host-authorized workspace 绑定范围内的 run（project-bound recovery）。只读、幂等——不修改任何持久状态、不追加 transcript event。

`runs_list` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入两字段均可选。`activeOnly`（bool，默认 `false`）：只返回**经证明 active** 的 run——即 transcript 为已知非终态**且**有 fresh owner heartbeat（`ownerLiveness` SSOT，默认 10s 阈值）。注意（M12-15）：单纯"未到终态"**不足以**算 active；一个非终态但缺少 fresh heartbeat 的 run 不在 `activeOnly` 结果里，但也**绝不**据此推断它 failed/dead/stopped（仍可能长时间运行/休眠），它计入 `unresolvedCount` 并仍出现在普通（非 `activeOnly`）列表中。`limit`（整数 1..100，默认 `50`）：返回条目数上限。模型**不能**传 `runDir`、registry、`agentId`、`cwd`、`workspaceRoot` 等 server-owned 配置——workspace 绑定由 server 解析，不能通过 tool argument 提供。

安全有界输出只返回机器字段 + 终态/活动事实，不含路径/session/prompt。`runs` 每个元素含 `runId`/`agentId`/`state`/`terminal`/`updatedAt` 以及 M12-15 的闭环活动投影字段：

- `activityStatus` ∈ `terminal` | `active` | `unresolved` | `unknown`
- `activityBasis` ∈ `terminal_state` | `fresh_owner_heartbeat` | `no_fresh_owner_heartbeat` | `unknown_state`

`active` 要求已知非终态 + fresh owner heartbeat；`unresolved` = 非终态但无 fresh heartbeat（**绝不**等同于 failed/dead/stopped）；终态与无法识别的 state 永不为 `active`。`returnedCount` = `runs.length`；`truncated` 表示因 `limit` 截断而仍有更多匹配 run；`unresolvedCount` = 全量扫描中已知非终态但缺 fresh heartbeat 的 run 数（受 `limit` 之前、与 `activeOnly` 无关），供 `lead_preflight` 复用而无需重新扫描。**绝不返回**：PID、进程路径、session id、argv、command、绝对路径、prompt、环境变量、messages、evidence 或异常 message/stack。失败返回固定安全文案 `runs_list failed`。

**R21 读绑定收官（TD-128，2026-08-19）——行 state/terminal/updatedAt 全路径绑定**：`runs_list` 每行的 `state`/`terminal`/`updatedAt` 只由本 run 自身信封事件计算（文件名 stem 即权威 runId）——MCP 查询缓存路径（`lead_preflight` 同一缓存）与 CLI 直读路径同语义（R20 只绑定了直读分支的 state/terminal，缓存路径仍历史读法）。尾部追加的外 run/伪造行不再翻转行状态/terminal 分类，也不再拉动 `updatedAt` 及由其派生的排序与 historyRange 窗。全无信封的 legacy transcript 保持历史读法；任一事件带信封即严格绑定，零绑定事件（整份只有外 run 信封行）降级 pending / `updatedAt:null`（宁可可见地缺事实）。`agentId` 仍为 events[0] 全量派生（append-only 首写不变量——按 TD-128 events[0] 类级登记维持）。

一次 `runs_list` / `lead_preflight` 查询会先证明授权 workspace，再按查询范围缓存每个不同 ownership cwd 的 Git 顶层证明（包括 fail-closed 的不可证明结果）；不会为同一项目的每个历史 run 重复启动 Git 证明进程。缓存只活在单次查询内，不跨调用持久化，也不改变 workspace 隔离、过滤或错误投影。

**Workspace-bound**：只返回当前 host-authorized workspace 绑定范围内的 run——其它项目的 run 不可见（project-bound recovery，不跨 workspace 探测）。workspace 未绑定时返回空 `runs:[]`（不 fail-closed，因这是只读列举而非 state-changing）。

CLI fallback：`npm run cli -- runs list [--agent ID] [--latest N]`。

## MCP resources `wao://playbooks`（可选只读 Lead Playbook Catalog，M11-2 / M12-10）

built-in Lead Playbook Catalog 通过 **MCP resources** 暴露（M12-10 起从工具面移出），是一个小型只读决策脚手架（evidence gate、adaptation point）。一个 playbook 给 Lead 紧凑的默认值、证据门和适应点；Lead 保留、跳过或修改任何条件步骤。**不要求**每次派发前读取，偏离 playbook 也无需 Owner 批准（除非既有权威规则已要求）。Catalog 不自动拆解任务、不选 worker、不派发、不推进 phase、不验收；**不存在** `playbook_run`/`playbook_start`/`playbook_next`/`playbook_recommend`。

两个只读 resources（`resources/read`，mimeType `application/json`）：

```
wao://playbooks              → { playbooks: [{ id, version, title, summary, lanePattern }] }   // summary，恰好四个内置 playbook，稳定顺序
wao://playbooks/{id}         → { playbook: <完整 PlaybookV1> }   // 详情：roles/phases/completionEvidence/escalation
```

`resources/list` 返回 summary resource + 四个已知 id 的 detail resource（`wao://playbooks/<id>`）；`resources/templates/list` 返回 `wao://playbooks/{id}` 模板。读取委托同一 `application/playbookCatalog.js` SSOT（`validatePlaybookSummaryList`/`validatePlaybookV1` 校验）。不要求 workspace binding，不读 transcript/registry/runDir，不产生任何 transcript 或文件副作用。未知 id 与 service 失败折叠为**固定安全错误**（`playbook summary failed`（summary resource）/ `playbook detail failed`（detail resource，含未知 id）），不回显 id、路径或 catalog 原始内容——唯一例外是协议要求回显 caller 提供的 `uri`。

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

CLI 只做 argv/format/console，数据逻辑委托同一 `application/playbookCatalog.js` service，因此 CLI `--format json` 与 MCP resource content 语义精确一致。unknown/malformed id 透传 M11-2A 固定 typed error（`PlaybookNotFoundError`/`PlaybookValidationError`），不输出 raw catalog/path。

## MCP `semanticNotes` + resources `wao://semantics`（Self-Describing Results，M12-12）

恰好四个 standalone 只读成功结果——`run_wait`/`run_await_result`/`run_delivery`/`run_diagnose`——携带 REQUIRED `semanticNotes`（1..4 条）。每条恰好三键 `{ id, meaning, doesNotMean }`：`id` 是冻结的 namespaced 闭集值（`observation.*`/`termination.*`/`delivery.*`/`diagnosis.*`），`meaning` 是一句确定性事实，`doesNotMean` 是 0..2 条确定性非含义。**没有** `scope` 字段、**没有** per-entry `semanticsRef`；详情 URI 机械派生 `wao://semantics/{id}`。

notes 完全由既有机器事实决定（M12-11 observation outcome / termination source、diagnosis category、delivery readiness / verification status），由单一纯 SSOT `src/application/runSemanticsNotes.js` 选择——**永不**回显 transcript/provider/path/prompt/command/session，**永不**建议 accept/reject/repackage/stop/retry/dispatch。关键不变量：`observation.read_failure` **不**产生任何终止 note；delivery note 明确 verification passed **不是** Lead acceptance；diagnosis note 只陈述事实、不给处方。`run_delivery_review_bundle` 嵌入的 nested delivery BASE **不含** `semanticNotes`。

两个只读 resources（`resources/read`，mimeType `application/json`）：

```
wao://semantics            → { semantics: [{ id, meaning }] }                 // summary：每个 id + meaning（无 doesNotMean）
wao://semantics/{id}       → { note: { id, meaning, doesNotMean } }           // 详情：单条完整 note
```

`resources/list` 返回 summary resource（`wao://semantics`）；`resources/templates/list` 返回 `wao://semantics/{id}` 模板。**不**把每个 detail id 注册为独立静态 resource。读取委托同一 `runSemanticsNotes.js` SSOT。未知/畸形 id 与 service 失败折叠为**固定安全文本**（`semantics summary failed`（summary）/ `semantics detail failed`（detail，含未知 id）），不回显请求 id 或目录原始内容——唯一例外是协议要求回显 caller 提供的 `uri`。
