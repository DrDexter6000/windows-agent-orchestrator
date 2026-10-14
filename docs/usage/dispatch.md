# 派发

> [使用手册](../usage.md)的一页：派出一个 worker：前台或后台、并行、工作树隔离、重试与恢复、授权续跑、运行中纠正。

## 所有命令都用 `npm run cli --` 前缀

```powershell
npm run cli -- <command> [options]
```

> **不要**直接 `node src/cli.js <command>`：系统默认 `node` 常是 v24（WAO 硬拒），`npm run cli` 走 v22 shim 才是可靠入口。下面为简洁省略前缀。

**已执行 `npm link` 后（M12-8F），优先用全局 `wao` 命令**：`wao <command> [options]` 与 `npm run cli -- <command> [options]` 等价（同一个 CLI、同一个 v22 shim），且可从任意目录调用。`npm run cli --` 嵌套形式仍完整保留。

> **记法约定（0062，B8）**：本文写 `wao X` 时 `wao` 指全局 shim。顶层命令（serve/run/registry/consult/…）的 shim 形就是 `wao X`；**wao 命名空间子命令**（doctor/onboarding/state/…）的规范形是 `npm run cli -- wao X`，shim 形为 `wao wao X`（两层 wao）。两种误敲（顶层裸 `doctor`、命名空间内 `wao serve`）均有 Unknown 指路（TD-191④ 正向 / TD-260 反向）。

> **脚本化消费（管道/jq，2026-10-02 实证）**：`npm run cli --` 的 stdout 会带 npm 横幅行（`> windows-agent-orchestrator@…`），直接 `| jq` 会炸——加 `-s`（silent）得干净输出：`npm run cli -s -- <command> --format json | jq`。**读转录文件（`runs/<runId>.jsonl`）时注意平铺形状**：事件的载荷字段合并信封顶层（`{kind, role, parts, ts, seq, runId, agentId, type}` 一层平铺）——**没有**嵌套的 `payload` 键；信封字段（ts/seq/runId/agentId/type）权威、载荷不得覆盖；`run.error` 的 `error`/`phase` 同样在顶层。消费输出时**优先用 projection JSON（`collect --format json`）——那是路径无关形状**；直读转录或 raw collect 才需要按 kind 形解析。`--format json` 的诊断输出自 2026-10-02 起含 `state`/`terminal`（非终态与"无失败事实"不再混淆）。

> **行为变更（2026-10-02 Lead 体验批，双席会审）：kimi-web 的 collect 改转录重建**——此前 collect 对带 serveUrl 的 run 一律走 OpenCode 消息协议拉活服务（对 kimi-web 是错适配器 + 无鉴权，从未成功过；会话被服务端回收后崩溃）。现在 kimi-web run 的 collect 与 process backend 同路：从转录事件重建（不变量 1），活服务不再参与 collect。三个连带语义：① 活 run 的 collect 返回**截至当前已落盘内容**的快照（与 process 一致，非实时拉取）；② raw 模式输出形状从 serve 信封变为重建条目（`reconstructed:true, backend:"kimi-web"`——backend 身份自 session.created 派生，不再误标 process；projection/`--format json` 面**字段结构**不变，但 `evidenceCounts` 计数值从 serve 形的 tool/command 全记 other 变为真实计数——机器消费字段的值会变，如 run_20261002121934119hkvz81 实得 command=30/toolUse=36/toolResult=67）；③ **跨版本翻页游标作废**——升级前发出的 serve 形 nextCursor 升级后按既有 fail-closed 语义拒绝（快照摘要不匹配），重新从第 1 页读起即可。停止验证消费者的 `handle.messages` 活会话探针不受影响。

## 场景 1：让 agent 做一件事并等结果

```powershell
# run = spawn + wait，打印 assistant 文本
npm run cli -- run glm-flash --prompt "总结这个项目的 README"

# JSON 输出（含完整 messages + metrics）
npm run cli -- run glm-flash --prompt "..." --format json
```

> **前台 vs 后台生命周期（TD-148 → ADR-0030/TD-151 根修，2026-09-18）**：等待窗（`--wait-timeout` / agent / global 配置三源）到期 = **通知，不杀**——WAO 只落一条 `run.observation_deadline_reached` 观察事实（载荷有界：waitTimeoutMs + source），前台 CLI 同刻打印一行指引后**继续等到自然终态**；`--background` 的 detached runner 同样只记事实、继续监督到自然终态。终止 worker 只剩两个来源：Lead 显式 `stop`；既有硬安全线（tokenBudget 闸门、workdir_escape 隔离守卫）。有界观察用 `runs wait <runId>` 自身的窗口（到期只结束观察、exit 0）；要 worker 脱离派发进程存活用 `--background`。`resume` 不带 `--wait` 已改为 detached runner 托管续跑（不再挂起）；`resume --wait` 前台等待期间本进程退出会 Job Object 连坐杀 worker——这是进程隔离的设计行为（见[安装与配置](install.md)的 Node v22 一节），要存活走后台托管。

> **行为变更（决定 0067，2026-10-12）：zcode 运行只在没有生命体征时自动收口**——此前已有产出后静默满 300–600s 即判 `turn stalled`（一周多里 12 次，其中 7 次死时有工具命令在跑）。现在收口门到点时（含零 part 阶段的 silentTimeout / 思考预算）先看生命体征：模型流在收、app-server 的后代进程在干活，或工作目录里有文件变化，就继续等且这一项没有任何自动上限；都没有才收口。模型流在收时转录每分钟落一条 `runtime_activity`（`streaming`），等待类命令据此显示有活动；CLI `status` 在转录里 ≥30 分钟没有新的动作或正文时附 `advisory`。`stop` / `run_stop` 同批对 zcode 运行生效。判据、读数与边界见 [troubleshooting §6.9](../troubleshooting.md#69-zcode-运行什么时候会被控制面自动收口生命体征口径决定-0067)。

> **行为变更（决定 0071，2026-10-13）**：kimi-web 运行的命令与工具调用在输入就绪后即落转录（此前要到整轮带着正文完成才出现）——`run_activity` 在命令还在跑时就看得到它。失败的轮里因此会留下在途时已落的命令、工具调用及其结果（此前零证据；留下多少随轮询时机而定，这类失败轮的诊断可能从 `crash` 变为 `no_effect`）。写文件证据仍只在整轮带着正文完成时落，在转录里会排在在途已落的命令之后。

> **行为变更（决定 0072，2026-10-13）**：① deepseek-acp 运行的 shell 命令在调用到达时多落一条 `tool_use`（此前命令要到结束才出现）；两个 deepseek 后端此前会把"上一条事件还在落盘时到达的事件"压到下一条事件到来才放出，现在不再等下一条事件。② kimi-web 的写文件调用在途先落一条 `tool_use`，输入只带 `path`；`file_written` 的落盘时机不变。③ scorecard 的 `requireCommands` 不再用"工具调用成功"推断命令退出码，除非后端声明能产出退出码证据（`reportsCommandExitCode`，见 [surface/certification.md](../surface/certification.md)）：在 zcode / kimi-web / deepseek-acp 上，命令事件不带数值退出码时这条规则此后**通不过**（这三个后端实测都不带；此前在 zcode 上跑过就通过——1335 条命令全被推成退出码 0，一次失败都没推出过）。kimi-code、deepseek-harness 自决定 0073 起同样不再推断。要验证这些车道上的命令结果，用 `requireAcceptance`（独立脚本验收）或把 `mode` 设为 `"warn"`；`wao registry validate` 会对 agent 级的这种配置给出 ⚠（`--scorecard-rules` 临时规则不在它的视野内）。

> **行为变更（决定 0073，2026-10-13）**：① kimi-code、deepseek-harness 两个后端不再声明"能产出命令退出码证据"（前者靠输出里的关键词猜成败，后者没有实测）。② 认证：命令退出码这一轴因后端如实声明不产出而不适用的车道评 `conditional`，不再停在 `draft-only`（其它 strict 轴不适用、要求的命令根本没跑，仍是 `draft-only`）。③ `run_activity` 的工具输出尾部（`tail`）也读文本块数组——deepseek-acp 的工具结果此前一直显示为空。④ deepseek-acp 运行在沙箱建不起来时，转录里落一条 system 消息，写明症状、harness 文档给出的常见原因与修法（每次启动后端进程一次）。

> **行为变更（决定 0074，2026-10-13）**：① deepseek-acp 车道的 `env.DSH_PERMISSION_MODE` 现在校验取值；沙箱建不起来时的 system 提示改为先给车道级修法。② kimi-web 车道可声明 `kimiHome`：token 取自该主目录的 `server.token`，这条车道在 `registry_list` 里显示 `not_required`（token 文件仍必需）。③ `wao lanes` 多一行 `concurrency`。④ kimi-code、deepseek-harness 两个后端暂停使用。⑤ `serve recycle` 重启的 serve 不带密钥类环境变量。⑥（决定 0075）kimi-web 车道可声明 `serveWorkspaceDir`：派发时 serve 没在跑即自动拉起。

> **行为变更（决定 0070，2026-10-13）**：`run_activity` 的 tool_use 条目多一个 `detail`（输入摘要），tool_result 条目多 `tail` / `truncated`（输出尾部）；codex 运行的转录在命令开始时多一条 tool_use（此前命令要到结束才出现）、结束时多一条带输出的 tool_result；codex / claude-code / kimi-code 的运行在转录静默满 5 分钟后会落 `runtime_activity`（`process_active` / `files_changed`）——此前这些后端在长命令期间转录是空的。

> **行为变更（决定 0069，2026-10-13）**：`run_stop` / `stop` 新增两个必填项——看到的转录位置与理由，缺了不执行；`run_activity` 的 command 条目给出命令原文，条目缺省最新在前；kimi-web 凭 serve 证词续命时转录落 `runtime_activity`（`serve_active`）；每个后端在认证面登记自己的生命体征与收口方式（`docs/surface/certification.md`）。

> **行为变更（决定 0068，2026-10-12）**：kimi-web 的 30 分钟证词硬顶改为自上次产出增长起算（此前按整 turn 累计、有增长也不清零）；zcode 凭进程活动 / 文件变化续命时转录落 `runtime_activity`（`process_active` / `files_changed`，每种至多每分钟一条）；MCP `run_status` 新增可选 `leadAdvisory`，`run_wait` / `run_await_result` 新增注记 `observation.transcript_quiet`。

> **行为变更（TD-199，2026-10-02）：zcode 工具证据改轮询期增量落盘**——此前 zcode 的全部工具证据（command/tool_use/file_written/tool_result）积压到轮末一次性进转录，长 run 运行期转录零事件、`runs wait` liveness 只有 process_only；现在工具证据随轮询节拍（CLI 缺省 5s）增量落盘。两个连带语义：① zcode delivery run 的**包容门从轮末批审变为写后即拦**——越界写的 `file_written` 证据一经轮询观察到，即在运行中段触发 `workdir_escape` 转 failed（**写后侦测拦截，非写前阻止**——包容是侦测不是沙箱；adversarialEscape 对 zcode 的拦截链从"轮末事后"变为真实在飞）；② 纯文本/纯思考段（无工具活动）仍零 run.event——增量投影只治愈工具活跃期的可见性，长文本段在途监督仍靠 liveness 观察与终态事实。

## 场景 1b：单次派发换模型（--model，R10-A）

本节正文（含 MCP `run_dispatch` 的 `model` 覆盖特有规则）已完整迁移至 `docs/certification-runbook.md` §场景 1b（单向链接；唯一权威）。

## 场景 1c：单次派发换推理力度（--reasoning，R11-1）

本节正文（含 MCP `run_dispatch` 的 `reasoning` 覆盖特有规则）已完整迁移至 `docs/certification-runbook.md` §场景 1c（单向链接；唯一权威）。

## 场景 2：后台跑（fire-and-forget）

```powershell
# spawn 不带 --wait，立即返回 runId
npm run cli -- spawn researcher --prompt "分析 auth 模块并列出风险文件"

# 之后查看状态
npm run cli -- status <runId>
npm run cli -- tail <runId>          # 看最后几个事件
npm run cli -- tail <runId> --follow # 实时跟踪

# 阻塞等待 run 到终态（或观察窗口到期）
npm run cli -- runs wait <runId>                     # 默认窗口 270000 ms，text 摘要
npm run cli -- runs wait <runId> --wait-ms 600000    # 窗口 180000..600000 ms
npm run cli -- runs wait <runId> --format json       # 完整服务结果 + semanticNotes
```

> 注（TD-137③）：runId 内嵌时间戳为 UTC；本地时间需自行换算。

`runs wait` 与 MCP `run_wait` 工具共用同一等待服务（只读长轮询，不写 transcript）：
默认 `--format text`（runs 家族惯例），`--format json` 输出完整服务结果并附
`semanticNotes`（与 MCP 同一 selector）。观察窗口到期（`terminal:false`）是正常
结果——正常打印、exit 0，不代表 worker 停止或失败；等待期间 Ctrl-C 会打印中断
时刻的快照后以非零退出。`--wait-ms` 越界或非整数由服务边界原样报错（exit 1）；
非数字值（如 `--wait-ms abc`）在 CLI 层即以固定文案 `--wait-ms must be a number` 拒绝
（不回显原值，service 不被调用）。
`runs` 的未知子命令（如 `runs waitx`）会 fail-closed 报错并列出全部合法子命令；
裸 `runs` 仍保持列出 run 列表。

工作目录（显式 `--cwd`，缺省时 registry 条目的 `cwd`）**必须是已存在的目录**。
不存在（或是文件）时派发/执行在任何副作用之前被拒绝——typed error
`DispatchCwdNotFoundError`（reasonCode `dispatch_cwd_not_found`，message 含解析后的
绝对路径与来源标注；零 transcript、零 fork、零 worktree）。检查按 backend 能力划分
（与 M12-14 invocation 预检同一 capability 键 `preflightInvocation`）：本地进程式
backend（claude-code / codex / kimi-code / deepseek-harness / deepseek-acp）在两层都查，HTTP serve
backend（opencode-serve，cwd 是远端目录提示）两层一致豁免。**承重层是前台执行通道**
（`run` 前台、workflow agent 节点、daemon `start`、`retry` → RunManager.start，以及
`resume` 的进程重放分支 → RunManager.resume）——2026-08-16 的 22 条 researcher
spawn_error 事故全部走 workflow 通道，即此层；**后台派发通道**（`run --background` /
`spawn` / MCP `run_dispatch` → dispatchRun 派发服务层）是同款 typed 早拒绝的预防面
（transcript 写入与 fork 之前）。判读与旧 transcript 的排障见
`docs/troubleshooting.md §3.2`。

## 场景 2b：上游空窗期的派发活性重试（TD-158，Lead 工具层脚本）

上游间歇空窗期派发会秒败空跑（~30s 零产出）；`scripts/dispatch-with-liveness.mjs` 收编 Lead 手写的"派发→观察→查活性→退避重派"循环：

```powershell
node scripts/wao-node.cjs scripts/dispatch-with-liveness.mjs --agent glm-pro --prompt-file task.md --cwd D:\proj\x -- --model gpt-5.6-sol
```

重派谓词三条件同时满足才重派；退出码如实：**真完成（completed 且非空跑）=0**，其余（失败/谓词不满足/轮次耗尽/派发失败）=1：① 前一轮已 terminal；② 带 `completed_empty`/零证据 marker（`DIAGNOSIS_CODES` 闭集语义，与 `runs diagnose` 同一投影）；③ 证停新鲜度前提（复核四审定谳）：终态后 settle 重读**成功**（`stopRereadOk`）是条件③两臂的共同前提——重读失败时旧快照的证停可能已被其后落盘的未证停事实压掉，两臂全关不重派。重读成功后：默认严格臂=`run.stop_verified`（类别是注册表事实而非本 run 进程已退出证据——processBackend 存在 done(failed)-while-alive 路径）；类别臂仅为显式 opt-in 启发式（`--allow-process-death-inference` 且无显式 `run.stop_unverified` 事实）。不变量：**绝不中止/重试在飞 run**（派发走后台分离 + 独立观察窗，不挂 `--wait-timeout`——ADR-0030 起该窗到期只通知不杀，活性判定本来就归本脚本自己的谓词——TD-148）；零产出 ≠ 没在工作（纯调研零写入合法，观察窗内活跃即继续等）。出处 TD-158；纯函数面钉于 `test/registry-roles/dispatchLiveness.test.js`。

## 场景 3：并行跑多个 agent

```powershell
# 同时启动多个，--wait 等全部完成
npm run cli -- spawn glm-pro glm-flash --prompt "审查这个函数" --wait
```

## 场景 4：worktree 隔离（每个 run 独立工作树）

```powershell
# 方式 A：命令行 flag（临时）
npm run cli -- run glm-flash --prompt "..." --isolate

# 方式 B：registry 配置（持久）
# 在 agents.json 里给 agent 加 "isolation": { "type": "worktree" }
```

隔离后，agent 在 `<cwd>/.wao-worktrees/<runId>/` 里工作，不污染主工作树。

**Worktree checkout 卫生（M11-1B）**：WAO 在创建首个 worktree 前，会在仓库本地 `.git/info/exclude` 写入恰好一条根忽略规则 `/.wao-worktrees/`，使持久 worktree 目录不出现在源工作树的普通 `git status --porcelain` 输出。该规则是**稳定 repository-local hygiene 规则**（不编辑 tracked `.gitignore`、不隐藏任意 worker 产出；worktree 删除后仍保留）。WAO 保留既有 exclude 字节（含 BOM、CRLF/LF、用户规则），对已存在的精确规则幂等。`git worktree add` 失败时**保留该稳定规则，不回滚**——规则只在 exclude ensure 自身失败（write/read-back verify）时回滚到调用前字节。该规则与 host activation（如 Codex `mcp bind`）的 marker block 互相独立，移除一个不会影响另一个。

## 场景 5：重试 / 恢复

```powershell
# 重试：用原 run 的 prompt 重新跑一个新 run
npm run cli -- retry <runId> --wait

# 重试时替换源 run 的 per-dispatch 覆盖（显式 flag 优先于继承值）
npm run cli -- retry <runId> --model <id> --reasoning <effort>

# 恢复：接续一个未完成的 run
#   opencode-serve：attach 到已有 session
#   claude/codex：重放原 prompt（进程式无法 attach，只能重放）
#   不带 --wait = detached runner 托管续跑（CLI 立即返回，worker 存活）；
#   --wait = 前台等待（本进程退出会 Job Object 连坐杀 worker——隔离机制设计行为）
npm run cli -- resume <runId> --wait
```

**resume 两种姿态（ADR-0030 实施批 / TD-148 姊妹脸根修，2026-09-18）**：

- **不带 `--wait` = detached runner 托管**：CLI 以 detached+stdio-ignore+unref 形状 fork 一个 resume runner 立即返回（不再被 respawn 子进程的 ref'd 管道吊住静默挂起）。runner 拥有续跑 handle，驱动 waitForCompletion（token 闸门 / 等待窗到期通知 / 自然终态）并写 ownership 心跳（daemon `--resume-on-start` 判活不劫持）。监督走 `runs status` / `runs wait`。CLI 侧先做廉价的终态/权威事实预检（bound findState + 首条绑定 `session.created`/`run.started`/`prompt.sent`——最后一项是进程重放所必需，缺失会在 fork 后被 runner 静默拒绝），已终态或不可续接的 run 直接打印既有拒绝形状（`resumed:false`），零 fork；预检与 runner 内权威 resume 之间的竞态由 runner 兜底。**fork 后失败的可见性边界（审计 P1）**：runner 内恢复失败不回传父进程（detached 语义）——三类主因已由预检拦截，runner 会向本 run 转录追加持久失败事实（run.error，phase=resume——恢复抛错或被拒两路都落盘，固定安全文案），监督侧用 `runs status`/`runs tail` 复核，不要只信 `resumed:true`。
- **带 `--wait` = 前台等待**：CLI 进程持有续跑 worker，等到自然终态；等待窗到期同 `run` 前台（通知不杀，见场景 1）。**本进程退出/被杀时 worker 被 Windows Job Object 连坐终止**——这是进程隔离机制的设计行为（见[安装与配置](install.md)的 Node v22 一节 / `.wao/decisions/0013`），不是缺陷、不修代码；要存活就不要用前台姿态挂着不管，用上面的托管续跑或 `--background` 派发。

**retry 的 per-dispatch 覆盖继承**（R12/R13：任务文本 runId 绑定取法、继承范围、坏持久化值 fail-closed、`--model`/`--reasoning` 替换 flag、reuse 形状与全新 provider session 边界）正文已完整迁移至 `docs/certification-runbook.md` §retry 的 per-dispatch 覆盖继承（单向链接；唯一权威）。

## MCP `run_dispatch`（supervised background dispatch，M9-2B）

`run_dispatch` 让 MCP host 正式派发一个受监督的后台任务。它直接复用与 CLI `run --background` 相同的 application service（`dispatchRun()`），不 shell-out CLI。WAO 拥有 dispatch、detached runner 和 transcript；模型只提供 worker 和 bounded prompt。

**M11-5 角色合同自动注入（TD-89 修复）**：Lead 只需写具体任务 prompt，无需复制角色说明，也无需切换到 WAO 仓库目录。WAO 根据 registry 中 agent 声明的 `systemPrompt`（指向 `config/roles/*.md` 角色契约），用共享加载器（`roleContract.js`）验证并以 runtime-native 方式恰好一次注入 worker——claude-code 用 `--append-system-prompt <内容>`，codex 用 `-c developer_instructions`，kimi-code 用固定分隔组合 role+task，OpenCode 1.18+ 用 message API 原生 `system` 字段且 task 仍只在 user text part 出现一次。**路径权威**：相对 `systemPrompt` 由加载器相对 WAO 安装根解析（不依赖调用者 cwd），所以从 Life Index 等外部项目目录调用也能找到全局角色文件。是否支持注入由 backend 能力声明（`supportsRoleContract === true`）严格判定；能力值非严格 true 时，配了 `systemPrompt` 会在 start（创建 transcript 前）/ resume（读取既有 transcript 后、append/spawn 前）fail-closed。**WAO 不把角色合同保存为 `prompt.sent`/控制面输入**——transcript 只持久化原始 task prompt（注意：worker 输出可能在回答中引用或复述角色，这由模型决定）。Lead/model 不能通过 `run_dispatch` 覆盖角色（strict schema 不接受 `systemPrompt`/`roleContract`/`rolePath`）。

**Kimi K3 模型策略**：registry 用结构化 `model.id` 与 `reasoning.effort` 表达每个 worker 的模型策略。`kimi-code/k3` 的 `low` / `high` / `max` effort 由 backend 编译为仅对子进程生效的 `KIMI_MODEL_THINKING_EFFORT`；WAO 不修改全局 Kimi 配置，也不接受同名 `agent.env` 作为第二权威。K3 的上下文上限来自 Kimi Code 模型目录（当前为 1M），不是 WAO 的进程级 override，因此 registry 不重复声明 `model.contextWindow`。

`run_dispatch` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入是 strict schema（拒绝额外字段）；schema 未列的一切（`registryPath`、`runDir`、`runId`、`cwd`、`workspaceRoot`、`requireCertified`、timeout、`isolate` 等）都是 server-owned 配置，模型不能传。

M9-7A 起支持可选 `delivery` 块（嵌套形状以 wire 为权威），用于派发后续可由 `run_delivery`/`run_delivery_decide` 操作的 delivery run：

```json
{
  "agentId": "glm-flash",
  "prompt": "bounded task prompt",
  "delivery": {
    "mode": "git_commit_v1",
    "allowedPaths": ["src"],
    "verificationSetupCommands": ["npm ci"],
    "verificationCommands": ["npm test"],
    "verificationTimeoutMs": 1200000
  }
}
```

`delivery` 可选。`verificationCommands` 与 `verificationUnavailableReason` 二选一（互斥）。WAO 强制 persistent worktree isolation——模型不能传 `isolate`（隔离不是可选输入）。 registry certification 的定位（advisory 证据、非 permission gate、显式 CLI `--require-certified` opt-in 门与 MCP 差异）正文见 `docs/certification-runbook.md` §认证与当前就绪（单向链接；唯一权威）。

**行为变更（TD-131/TD-132 认证门收口 + R23-C 认证身份维度补全）**正文（`--require-certified` 完整门合同：身份四元组比对、`lastFullHealthyRunAt` 新鲜度与 legacy 回落、`manualOverride:"cleared"` Owner 旁路、MCP `requireCertified:false` 差异、配套可见性 advisory）已完整迁移至 `docs/certification-runbook.md` §认证与当前就绪（单向链接；唯一权威）。

**M12-13 per-command 执行预算（可选，`verificationTimeoutMs`）**：Lead 可选为 delivery 声明**单条 verification 命令的执行超时/预算**（整数 ms，共享闭界 `[1000, 7200000]`，默认 300000 **仅在字段缺失时**应用）。这不是 `run_wait` / `run_await_result` 的观察窗口——它约束 exact verifier 的逐条 setup/assertion 命令执行。语义：
- **验证先于副作用**：非法值（字符串/小数/越界）在派发/start/resume 的任何 transcript append、worktree 创建、spawn/attach、打包、验证之前经 `prepareDeliveryRequest` SSOT 拒绝（`invalid_verification`），零转录、零 worktree、零 spawn；
- **零漂移**：仅在显式声明时持久化（`run.started.delivery.verificationTimeoutMs`、`delivery_created` ref、verification outcome ref 都保留该值）；未声明则任何事件/ref 都不出现该字段，消费者才用默认值；
- **持久值权威**：贯穿 start / resume（resume 重新经 SSOT 校验，持久值损坏则 resume 直接拒绝 null，零副作用）、profile 折叠（profile 只供命令，Lead 声明的预算保留）、MCP/CLI 转发、`run_dispatch_contract_check` advisory 校验、`run_delivery_repackage` 原值重建与 verifier 调用、reverify 继承（省略 `timeoutMs` 时继承 ref 上持久化的预算，持久值损坏则 fail closed；显式值同样必须落在共享闭界内）；repackage 中字段缺失仍交给 verifier 默认值，字段存在但损坏则在 inventory/Git/transcript/verify 前拒绝；
- **无自动动作**：从不自动加宽、从不重试、从不因超时自动 stop/decision——超时结果如实投影为闭集 `command_timeout` / `setup_timeout`。

**M12-7 continuable 续谱根（delivery-only 可选）**：`run_dispatch` 顶层可带 `"continuable": true`（与 `delivery` 同级，不在 delivery 块内），把这次 delivery 标记为一条**可续谱系（continuable lineage）的根**。dispatch 会以 `run_lineage` / `turn:first` 建立一个 provider-native 会话（opaque uuid 由 server-owned Lead session + canonical workspace + canonical agentId + 该 run 的 rootRunId 派生），保留 retained worktree。这样日后 Lead 若审阅该终态 delivery、发现窄缺陷，可用 `run_continue` 对其续 ONE 修正回合——复用同一 retained worktree、以 `turn:resume` 续同一 provider 会话（同一 opaque uuid）。TD188 起，若 runtime 在 wire 上广告自己的 native 会话 id（kimi `session.resume_hint` / codex `thread.started`），该 delivery run 会在终态前把它记为 `run.provider_session_bound` 绑定事实（`session.created` 保持唯一 `proc_<pid>` 进程身份），供后续 `run_continue` 取回真实 provider 会话续接（见 `run_continue` 节）。`continuable` 默认 `false`，省略时与普通 delivery dispatch 字节兼容；`continuable:true` 必须配 `delivery`（service 强制 delivery-only，否则 fail-closed）。WAO 从不在 dispatch 时推断或触发任何续跑/修正——是否续跑完全由 Lead 事后显式调用 `run_continue` 决定。

**资格与拒绝文案（2026-10-04）**：`continuable` 的后端资格以后端类声明（`supportsSessionReuse`）为准——人读投影见生成层 `docs/surface/certification.md` 能力列（registry 的 `sessionReuse` 条目是路由配置，**不是**能力证明）。资格拒绝携带固定原因码 `continuable_backend_unsupported`，缺 delivery 拒绝携带 `continuable_delivery_only`（MCP 固定文案，不回显席位/workspace/backend 名）。事故背景：`docs/incidents/2026-10-04-continuable-resolver-drift.md`。

**R4 只读声明（可选，`readOnly`）**：`run_dispatch` 顶层可带 `"readOnly": true`（CLI 等价 `run --read-only`），把这次 run 声明为**只读**。声明链路是"声明 → 强制隔离 → 观察"：`readOnly` 强制 worktree 隔离（TD-251/决定 0057：非复用轮=ephemeral——终态且停止验证确认后回收树，停止未确认则留树保迟到收取；sessionReuse 复用轮=persistent——kimi 会话 server 侧 cwd 钉在首轮树；worktree 创建失败时 fail-closed 拒绝派发——typed `read_only_worktree_required`，**不走**普通 run 的降级原 cwd 路径），start 时恰一次写入 `run.read_only_declared` durable 事实（见 [transcript 格式](transcript.md)的事件表），之后 `run_activity` 在快照含该声明时附带 advisory `readOnlyObservation`（见[监督](supervise.md)的 `run_activity` 一节）。`readOnly` 与 `delivery` 块互斥（固定拒绝文案携带闭集理由码 `read_only_delivery_conflict`；CLI 侧 `--read-only` × `--delivery-spec-file` 同样拒绝）；与 `correctable` 可共存（correction 是 Lead 显式指令，声明与观察并存）；`readOnly` × `continuable` 被既有 delivery-only 门自然拒绝。**诚实上限（三句）**：① 观察基于 worker 工具上报的 `file_written` 证据（`no_writes_observed` 的含义是"未观察到写"，**不是**"没写"），不是全知监控；② 强制隔离与越界侦测是**侦测机制**，不是 OS 沙箱——隔离降低误写面，但不能物理阻止越界写；③ 观察是 **advisory 非门**——观察到越界写不会自动停止、不会失败、不改写 run 的自然终态，终审归 Lead。另注意与 `wao ask` 的 prompt 级只读边界（快捷派工默认注入的只读提示词）区分：那是**不可验证、无持久事实**的 prompt 约定；控制面 `readOnly` 声明则有 durable 事实事件 + 基于上报证据的观察投影。

**R10-A 单次模型覆盖（可选，`model`）**的 MCP 特有规则已并入 `docs/certification-runbook.md` §场景 1b（与 CLI 覆盖正文合并维护；单向链接；唯一权威）。

**R11-1 单次推理力度覆盖（可选，`reasoning`）**的 MCP 特有规则已并入 `docs/certification-runbook.md` §场景 1c（与 CLI 覆盖正文合并维护；单向链接；唯一权威）。

**verification 环境合同（M12-6 FR-05/FR-06）**：Lead 可选声明 `verificationSetupCommands: string[]`——在 assertion 命令（`verificationCommands`）之前顺序执行的"环境准备命令"（如 `npm ci` 安装依赖、生成构建产物）。setup 与 assertion 分开验证、持久化与投影：setup 失败投影为闭集 `setup_failed` / `setup_timeout` / `setup_environment_error`，**绝不**伪装成 assertion 的 `command_failed`，不泄漏命令体/路径/stderr。每条 setup 与每条 assertion 之后都重做 exact delivery commit / 受跟踪工件证明，任何 tracked artifact 或 lockfile 漂移 = `artifact_mutated`（setup 漂移时 assertion 不执行）。exact-artifact verifier 运行在**独立的 per-attempt 临时环境**：每次 setup / assertion 命令各创建唯一 temp 目录并注入 `TMP` / `TEMP` / `TMPDIR`，两个 attempt 不复用、不复用 worker temp，仅持久化安全布尔事实（不含绝对路径）。**依赖不继承**：selected / worker worktree 的 `node_modules` 等 ignored / untracked 依赖**不会**自动出现在 exact verifier 环境——需要 Lead 声明 `verificationSetupCommands` 来准备。

**Workspace binding（M10-pre2 + M11-6）**：`run_dispatch` 在调用 shared service 前**重新解析并证明** workspace（优先级：Lead 会话选择 `workspace_select`（`lead_session`）> MCP client roots/list 恰好一个合法 `file://` root（`mcp_root`）> 显式 `--workspace-root`（`server_config`）> 否则 fail-closed）。证明后的 canonical Git root 作为 `cwd` 传给 dispatcher。workspace 未绑定时 dispatcher 不会被调用（零 transcript、零 fork），返回固定安全文案。**M11-6**：Lead 可在当前会话用 `workspace_select` 选择 Git 项目（最高优先级），无需 Human Owner bind、无需项目配置、无需重启——失败选择不影响既有会话状态，也不写任何持久配置。

- **输出**（成功或拒绝同形，MCP `content` + `structuredContent`）：字段清单见生成层。**身份绑定（M11-8B final）**：返回的 `agentId`（transcript envelope 盖戳的 canonical worker 身份）必须精确等于请求的 `agentId`——这是控制面对派发的身份绑定，不允许"合法但属于另一个 worker"的 id、missing/unknown/非法值；mismatch 一律折叠为固定 `run_dispatch failed`（`isError:true`、无 `structuredContent`、不泄漏返回值）。`run_dispatch` 永不返回 `"unknown"` 哨兵（那是 read 类工具的降级值）。不返回绝对路径、PID、prompt、argv 或内部错误。service 失败时返回固定安全文案 `run_dispatch failed`，不拼接原始 exception message、stderr、路径或凭据。

**M12-25 provider session routing truth（Outcome 2）**：`providerSessionRouting` 是闭集 `"not_used" | "first_turn_requested" | "resume_requested"`，描述**本次派发的路由请求**真相，**不是** provider 会话成功/建立的证明。派生仅来自 `dispatchRun` 内部已选定的路由回合（`routing.turn`）：普通一次性派发（含普通 delivery 的 `lead_workspace` 复用，该复用是**有意不使用** provider session）→ `not_used`；reusable expert 首轮 / continuable delivery 根首轮 → `first_turn_requested`；reusable expert resume / continuable 续接 → `resume_requested`。`accepted:false` 早返回恒为 `not_used`。**绝不**暴露 routing mode、opaque session uuid、Lead id、workspace path、argv 或 provider payload——这些是 server-owned 内部细节。该字段只如实说"请求了什么路由"，provider 是否真正 resume 成功仍由后续 `run_status`/`run_await_result` 的传输与终态证据决定；WAO 不据此自动决定路由、不自动重试、不自动 stop。

**行为变更（R14 / TD-128a，reuse 路由）**：reuse 路由对前任 run 的 `session.created` 存在性检查（决定 busy/resume/first 分派）自 R14 起为 **runId 绑定读取**（绑定到前任 runId）——尾部追加的外 run 伪造 `session.created` 不再能把一个 crashed-pre-conversation 的前任 run 翻转成 resumable。由此，**前任 run 的 transcript 为信封前 legacy 格式（事件无 `runId` 字段）时，reuse 路由从 resume 降级为 first**（走既有"terminal 无 session.created"分支，认领槽位开新回合）——不复用无法归属到前任 run 的会话；本机 pre-envelope transcript 存量为 0（TD-129b 实测），实际影响 ≈0。

**行为变更（R15，reuse/lineage 路由的 findState）**：reuse 与 lineage 路由对前任 run 终态的判定（`findState`）自 R15 起同样为 **runId 绑定过滤**（状态只由前任自身事件计算）——尾部追加的外 run 伪造 `run.state_change` 不再能把在飞前任翻成 resume（并发驱动同一 provider 会话，Contract 6）或把终态前任伪造成在飞而阻断派发。全无信封的前任 transcript（零绑定事件）按 **busy** 处理（不可归属 = 永不并发驱动；实测存量 ≈0）。

返回时 transcript 已可读且为 `pending`；关闭 MCP host 后，detached runner 独立驱动 worker 到自然终态（token 闸门/等待窗到期通知/兜底 abort 都生效——ADR-0030：到期不杀），写入共享 transcript。Lead 用 MCP `run_status` 轮询状态。

## MCP `run_continue`（Lead 授权修正续跑，M12-7）

`run_continue` 让 Lead 对一个**终态 continuable delivery** 续 ONE 修正回合。典型场景：Lead 审阅一个 delivery、发现窄缺陷（如一个漏改的边界条件），显式授权一次修正——WAO 创建**新** run/transcript，**复用父 run 的 retained worktree**（不开新 worktree、不开新 provider 会话），以 `turn:resume` 续同一 provider-native 对话，并打包新的 child delivery。MCP adapter 直接委托 application service `continueRun()`，不 shell-out CLI；M12-7 没有新增 CLI 子命令。

**Lead 语义唯一，WAO 不推断**：correction 的存在、范围、verification、retry、acceptance 全部由 Lead 决定——`run_continue` 只在 Lead 显式调用时发生一次，从不自动续跑、从不扩大范围、从不自动重试/接受/拒绝。child delivery 的 review/accept/reject 仍走 `run_delivery_review` / `run_delivery_review_bundle` / `run_delivery_decide`，归 Lead。

**续谱作用域（非 project-wide coder 复用）**：复用的是**这一条谱系**的 provider 会话——opaque uuid 由 server-owned Lead session + canonical workspace + canonical agentId + **root runId** 派生，跨一条 lineage 复用。它与 M11-11C 的 `lead_workspace` expert 复用是不同的 routing 模式（`run_lineage` vs `lead_workspace`），互斥：`continuable` 是 delivery-only，`lead_workspace` 是非 delivery。

`run_continue` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入是 strict schema：`parentRunId` + `prompt` + **必填**的子 `delivery` 块（嵌套形状以 wire 为权威）。

`parentRunId` 必须是一个**终态**且 `continuable` 的父 run（其 `run_dispatch` 顶层带了 `continuable:true`）。已 accepted 的父 delivery 不可续；Lead 应为已接收成果另建新 run。`delivery` 必填（续跑总是 delivery run，child 会从谱系原始 baseCommit 打包累计 candidate，而不是只打包本轮 correction delta）。因此 child 的 `allowedPaths` 必须**覆盖父 retained 成果的全部累计 changed paths**（父成果 + 本轮修正）；WAO 不会替 Lead 推断或扩展范围。**M12-22 累计范围真相**：这一覆盖关系在 read-only 资格阶段即被核对——`run_continue` 从权威 Git/worktree 事实派生父 retained worktree 中**仍存在**的实际变更，复用既有 containment SSOT（`isPathAllowed`，segment-boundary 语义）与既有 inventory 上限，在任何 mutation 之前与 child `allowedPaths` 比对。若存在未被覆盖的继承路径，`run_continue` 以 `continuation_scope_incomplete` 拒绝，并返回**有界的仓库相对事实**（`inheritedChangedPaths` / `inheritedChangedCount` / `inheritedChangedTruncated` 与 `uncoveredInheritedPaths` / `uncoveredInheritedCount` / `uncoveredInheritedTruncated`，已排序去重、按既有 inventory cap 截断），供 Lead 显式批准累计范围后重试。WAO 绝不自动扩展范围、自动恢复文件、重试或接受，也不暴露绝对路径、prompt、command、provider/session 数据或任意 Git 错误。一个被授权用于 correction 的路径随后可被 restore 回 base 并从最终 delivery 中消失——WAO 不解读该语义选择；child 自身最终 diff 仍由既有 packaging containment 闸门（`disallowed_path`）治理，本检查**未削弱** packaging。模型不能传 workspace/registry/runDir/cert——这些 server-owned，由 MCP 边界从绑定 workspace 解析。

- **资格检查（read-only，先于任何 mutation）**：WAO 在 claim 续谱槽 / 转换 worktree / 写 transcript / fork 之前，以 closed-set `rejectionReason` 拒绝不合格的续跑：`malformed_input` / `invalid_delivery` / `parent_not_found` / `parent_not_terminal` / `parent_accepted` / `not_continuable`（父 run 非 lineage 续谱根，legacy 不可续）/ `no_provider_session` / `workspace_mismatch`（父 run 不属于当前绑定 workspace）/ `no_delivery`（父 run 缺 delivery 上下文）/ `worker_configuration_changed`（当前 backend/model/provider 配置已不同——R23-C 起父 run 的 provider 接入方指纹一并比对：父侧 durable 事实是 `run.started.providerKey`（归一化 baseUrl + `apiKeyEnv` 变量名，与认证门身份比对同源 `providerKeyFor`；userinfo/query/fragment 已被归一化丢弃，凭据不入比对）。父 `providerKey` 为显式 `null`（父跑时无接入方）而 registry 现配了 provider 块 → 不匹配拒绝——原生直连的 lane 不得静默挂上新接入方；legacy 父 transcript 无该字段则跳过该维——不能继承旧 provider session）/ `unsupported_backend`（backend 未声明 session reuse）/ `missing_worktree` / `worktree_drift`（retained worktree 丢失或 base/分支漂移）/ `continuation_scope_incomplete`（M12-22：child `allowedPaths` 未覆盖父 retained 累计变更——retained-worktree 证明之后、claim 续谱槽之前的 read-only 阶段即返回有界 inherited/uncovered 事实，零 side effect，不自动扩展范围）/ `busy`（同一谱系已有非终态 owner 在跑）。静态 argv 与 credential 检查也在 mutation 前完成；开始转换后若 transcript 或同步 spawn 失败，WAO 机械恢复父 worktree、删除 orphan child transcript 并释放谱系 claim。第二次 worktree 证明若发现外部漂移，只报告事实，不覆盖外部状态。这些 closed-set refusal 是**正常结构化结果**（`accepted:false` + `rejectionReason`），不是 MCP error；环境/内部执行错误仍保持既有固定安全错误边界。

- **TD188（2026-09-27）真实 provider 会话续接与缺证据 fail-closed**：`no_provider_session` 覆盖**完整**可续接检查——在 registry 身份一致与 backend 支持检查之后、claim/worktree/child transcript/spawn 之前，`run_continue` 用与 spawn 权威（`RunManager.start`）相同的共享读取器 + backend 可用性钩子判定父转录是否持有该 backend 可续接的真实 provider 会话 id。kimi/codex（会话 id 由运行时自产、只在 wire 上广告）的父 run 若只记录了进程占位身份（`session.created.backendSessionId=proc_<pid>`）而无 `run.provider_session_bound` 绑定事实 → `no_provider_session`，零副作用（这正是修复前把 `proc_43244` 交给 `kimi -r` 导致上游 Session not found、child 零工具执行的事故路径）；带有效绑定事实 → 续接使用真实 native id。claude-code 父 run 的 proc-only 形状**照常可续接**（其 resume 编译路由 opaqueUuid `--resume <uuid>`，从不消费取回 id）；ACP 的 native `session.created` 语义不变。历史 Kimi/Codex proc-only 父 run 本轮明确不可续接（不迁移旧数据）；重新派发的新 continuable run 会记录绑定事实。

- **输出**（成功 / 拒绝同形，MCP `content` + `structuredContent`）：字段清单见生成层。成功返回新 child 的 dispatch 身份 + 谱系事实（`parentRunId` + `continuation:true` + `rootRunId`）。拒绝时 `accepted:false`、`rejectionReason` 为闭集码、其余成功字段为 `null`；`continuation_scope_incomplete`（M12-22 累计范围未覆盖）是唯一额外携带累计范围事实的拒绝形状，供 Lead 显式批准后重试（见下）。**`busy` 只回 label，不回 active runId**——opaque provider uuid、Lead id、workspace 路径、active lineage runId、transcript 路径**永不**出现在 MCP 输出（与 `run_dispatch` reuse-busy 脱敏合同一致）。`continuation_scope_incomplete` 是唯一携带累计范围事实（`inheritedChangedPaths`/`inheritedChangedCount`/`inheritedChangedTruncated` 与 `uncoveredInheritedPaths`/`uncoveredInheritedCount`/`uncoveredInheritedTruncated`）的拒绝码——这些有界仓库相对字段仅在 `continuation_scope_incomplete` 拒绝中出现，成功与其余拒绝均不携带；任何畸形/不安全路径在该字段投射时 fail closed 为整体省略（闭集 reason 仍保留），绝不泄漏绝对路径或 Git 错误。

- **retained-worktree 转换（幂等、崩溃安全）**：把父的 retained worktree 重新钉到 base 上、切到 child 分支 `wao/<childRunId>`，把父的 delivery/candidate 字节保留为 unstaged 工作改动；**父 commit 对象永不删除**，仍可按 SHA 审阅。child 从 base 打包自己的 delivery。

workspace-bound：父 run 必须属于当前绑定 workspace，否则 `workspace_mismatch`。

## MCP `run_correct`（运行中显式纠正，M12-16）

`run_correct` 让 Lead 对一条仍在执行、且派发时显式声明 `correctable:true` 的 run 发送一条**有界纠正消息**。它与 `run_continue` 不同：`run_correct` 不创建 child run、不切换 worktree、不重新派发 worker，而是把 Lead 明确提供的纠正写入原 run 的 durable transcript 队列，再由原 runner 串行投递给同一 provider 进程。普通 `run_dispatch` 省略 `correctable` 时保持原行为；backend 未声明 in-flight correction 能力时，`correctable:true` 在创建 run 前 fail closed（固定原因码 `correctable_backend_unsupported`；能力列见生成层 `docs/surface/certification.md`）。

输入是严格对象：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。`correctionId` 为 1..64 字符的 `[A-Za-z0-9_-]` 幂等键，`prompt` 为 1..15000 字符。相同 `correctionId` + 相同 prompt 可安全重查；同一 id 配不同 prompt 固定拒绝。工具只接受 workspace-bound、处于 submitted/running 阶段的 run；pending 尚未可投递，终态 run、未 opt-in run、跨 workspace run 或不支持的 backend 均返回闭集拒绝事实，不自动 retry、stop、continue 或改状态。

输出 `outcome` 是 `queued | pending | delivered | rejected` 的闭集。语义必须逐层区分：

- `queued` 只证明纠正已 durable append，等待 runner claim；
- `pending` 表示已有请求但尚无可确认的最终投递事实；
- `delivered` 只证明字节已送入 provider stdin，**不证明模型已读取、理解或执行**；
- `rejected` 携带闭集 `reason`，不回显 prompt、provider payload、session、路径或内部错误。

runner 以 requested → claimed → delivered/delivery_failed 的 durable 事件链串行处理；`run_activity` 只暴露安全的 correction 生命周期状态，不返回纠正正文。WAO 不判断纠正内容是否合理，也不会据此扩大 `allowedPaths`、改 verification、自动停止或接受交付；这些语义和最终决策仍完全属于 Lead。
