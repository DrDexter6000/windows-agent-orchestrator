# 派发

> [使用手册](../usage.md)的一页：派出一个 worker：前台或后台、并行、工作树隔离、重试与恢复、授权续跑、运行中纠正。

## 所有命令都用 `npm run cli --` 前缀

```powershell
npm run cli -- <command> [options]
```

不要直接 `node src/cli.js <command>`：系统默认 `node` 常是 v24，会被 WAO 硬拒；`npm run cli` 走 v22 shim，是可靠入口。下面为简洁省略前缀。

执行过一次性 `npm link` 后，优先用全局 `wao` 命令：`wao <command> [options]` 与 `npm run cli -- <command> [options]` 写法等价（同一个 CLI、同一个 v22 shim；全局 `wao` 从安装根解析配置与 `runs/`，见[安装](install.md)），可从任意目录调用。本文写 `wao X` 时 `wao` 指全局 shim。顶层命令（serve/run/registry/consult/…）的写法就是 `wao X`；wao 命名空间子命令（doctor/onboarding/…）可以直接裸写——全局 `wao doctor` 与 `npm run cli -- doctor` 都能执行，两段式 `wao wao doctor` 也照旧可用。把顶层命令写进命名空间（如 `wao wao serve`）会收到 Unknown 指路。

脚本化消费（管道/jq）：`npm run cli --` 的 stdout 带 npm 横幅行，直接 `| jq` 会炸——加 `-s`（silent）得干净输出：`npm run cli -s -- <command> --format json | jq`。`--format json` 的诊断输出含 `state` 与 `terminal`（非终态与"无失败事实"不再混淆）。读结果优先用 projection JSON（`collect --format json`）——那是路径无关形状；直读转录（`runs/<runId>.jsonl`）或 raw collect 才需要按 kind 解析。转录事件是平铺形状：载荷字段合并进信封顶层（`{kind, role, parts, ts, seq, runId, agentId, type}` 一层平铺），没有嵌套的 `payload` 键；信封字段（ts/seq/runId/agentId/type）权威、载荷不得覆盖；`run.error` 的 `error`/`phase` 同样在顶层。

kimi-web run 的 collect 从转录事件重建（与 process backend 同路），不访问活服务。活 run 的 collect 返回截至当前已落盘内容的快照，不是实时拉取。raw 模式输出重建条目（`reconstructed:true, backend:"kimi-web"`，backend 身份自 session.created 派生）；projection / `--format json` 面的字段结构不变，`evidenceCounts` 是真实计数。无效或跨版本的 cursor 按 fail-closed 语义拒绝（快照摘要不匹配），从第 1 页重读即可。停止验证消费者的 `handle.messages` 活会话探针不受影响。

## 场景 1：让 agent 做一件事并等结果

```powershell
# run = spawn + wait，打印 assistant 文本
npm run cli -- run glm-flash --prompt "总结这个项目的 README"

# JSON 输出（含完整 messages + metrics）
npm run cli -- run glm-flash --prompt "..." --format json
```

前台与后台共用一套生命周期规则：

- 等待窗（`--wait-timeout`，或 agent / global 配置，三源）到期是通知，不是终止：WAO 只落一条 `run.observation_deadline_reached` 观察事实（载荷有界：waitTimeoutMs + source），前台 CLI 同刻打印一行指引后继续等到自然终态；`--background` 的 detached runner 同样只记事实、继续监督到自然终态。
- 终止 worker 只有两个来源：Lead 显式 `stop`；硬安全线（tokenBudget 闸门、workdir_escape 隔离守卫）。
- 有界观察用 `runs wait <runId>` 自身的窗口（到期只结束观察、exit 0）；要 worker 脱离派发进程存活用 `--background`。
- 前台等到失败终态时（`run`、`spawn --wait`）不抛裸错误，返回 `{runId, completed:false, failed:true, timedOut:false, error, transcript, diagnosis?}`：`error` 超过 500 字符时截断并注明总长，`diagnosis` 是同一 runId 的诊断（同 `runs diagnose`）。

派发前看目标车道有没有 `dispatchHold`：那是 Owner 的暂停派发原话，只提示、不拦截，派不派由 Lead 决定；在哪里看得到见[车道](lanes.md)。

各后端什么时候会被控制面自动收口，判据、读数与边界见[监督](supervise.md)与 [troubleshooting §6.9](../troubleshooting.md#69-zcode-运行什么时候会被控制面自动收口生命体征口径决定-0067)。要点：zcode 运行只在没有任何生命体征（模型流在收、app-server 的后代进程在干活、工作目录里有文件变化）时自动收口，任一成立就继续等且没有自动上限；转录 ≥30 分钟没有新的动作或正文时，CLI `status` 附 `advisory`、MCP `run_status` 附 `leadAdvisory`、`run_wait` / `run_await_result` 附 `observation.transcript_quiet`，停不停由 Lead 决定。工具证据随轮询节拍增量落盘（CLI 缺省 5s）；纯文本/纯思考段（无工具活动）仍零事件，在途监督靠生命体征观察与终态事实。kimi-web 失败的轮会留下在途已落的命令、工具调用及其结果，诊断可能因此是 `no_effect` 而非 `crash`；写文件证据仍只在整轮带着正文完成时落。

## 场景 1b：单次派发换模型（--model）

单次派发覆盖模型（CLI `--model` 的用法，含 MCP `run_dispatch` 的 `model` 覆盖特有规则）见 `docs/certification-runbook.md` §场景 1b（单向链接；唯一权威）。

## 场景 1c：单次派发换推理力度（--reasoning）

单次派发覆盖推理力度（CLI `--reasoning` 的用法，含 MCP `run_dispatch` 的 `reasoning` 覆盖特有规则）见 `docs/certification-runbook.md` §场景 1c（单向链接；唯一权威）。

## 只派已认证的车道（--require-certified）

只派已认证车道（`--require-certified`）的完整门合同——身份四元组比对、`lastFullHealthyRunAt` 新鲜度与旧记录回落、`manualOverride:"cleared"` 的 Owner 旁路、MCP `requireCertified:false` 的差异——见 `docs/certification-runbook.md` §认证与当前就绪（单向链接；唯一权威）。

## 场景 2：后台跑（fire-and-forget）

```powershell
# spawn 不带 --wait，立即返回 runId
npm run cli -- spawn <agentId> --prompt "分析 auth 模块并列出风险文件"

# 之后查看状态
npm run cli -- status <runId>
npm run cli -- tail <runId>          # 看最后几个事件
npm run cli -- tail <runId> --follow # 实时跟踪

# 阻塞等待 run 到终态（或观察窗口到期）
npm run cli -- runs wait <runId>                     # 默认窗口 270000 ms，text 摘要
npm run cli -- runs wait <runId> --wait-ms 600000    # 窗口 30000..600000 ms
npm run cli -- runs wait <runId> --format json       # 完整服务结果 + semanticNotes + nextStep
npm run cli -- runs wait <runId> --until-settled     # 轮询到收口才退出（与 --wait-ms 互斥）
```

runId 内嵌时间戳为 UTC；本地时间需自行换算。

`runs wait` 与 MCP `run_wait` 共用同一等待服务（只读长轮询，不写 transcript）：默认 `--format text`，`--format json` 输出完整服务结果并附 `semanticNotes` 与 `nextStep`（与 MCP 同一 selector/模板）。窗口到期（`terminal:false`）是正常结果——正常打印、exit 0，不代表 worker 停止或失败；Ctrl-C 打印中断快照后非零退出。`--wait-ms` 越界/非整数由服务边界原样报错（exit 1）；非数字值（`--wait-ms abc`）在 CLI 层以固定文案拒绝（不回显原值，service 不被调用）。`--until-settled` 的收口定义、退出码（0/3/4/130）与诚实边界见 [supervise.md「等待到收口」](supervise.md#等待到收口runs-wait---until-settled-与-nextstep决定-0095)。未知子命令（如 `runs waitx`）fail-closed 报错并列出全部合法子命令；裸 `runs` 列出 run 列表。

工作目录（显式 `--cwd`，缺省时 registry 条目的 `cwd`）必须是已存在的目录。不存在（或是文件）时，派发/执行在任何副作用之前被拒绝——typed error `DispatchCwdNotFoundError`（reasonCode `dispatch_cwd_not_found`，message 含解析后的绝对路径与来源标注；零 transcript、零 fork、零 worktree）。检查按 backend 能力划分（capability 键 `preflightInvocation`）：本地进程式 backend（claude-code / codex / kimi-code / zcode / deepseek-harness / deepseek-acp）在两层都查；HTTP serve backend（opencode-serve、kimi-web：cwd 作为会话参数交给 serve）两层一致豁免。两层都拦：前台执行通道（`run` 前台、daemon `start`、`retry` → RunManager.start，以及 `resume` 的进程重放分支 → RunManager.resume）与后台派发通道（`run --background` / `spawn` / MCP `run_dispatch` → dispatchRun 派发服务层，在 transcript 写入与 fork 之前）。判读与旧 transcript 的排障见 `docs/troubleshooting.md` §3.2。

## 场景 2b：上游空窗期的派发活性重试

上游间歇空窗期派发会秒败空跑（约 30s 零产出）；`scripts/dispatch-with-liveness.mjs` 把"派发→观察→查活性→退避重派"循环脚本化：

```powershell
node scripts/wao-node.cjs scripts/dispatch-with-liveness.mjs --agent glm-pro --prompt-file task.md --cwd D:\proj\x -- --isolate
```

重派谓词三条件同时满足才重派；退出码如实：真完成（completed 且非空跑）=0，其余（失败/谓词不满足/轮次耗尽/派发失败）=1：

1. 前一轮已 terminal；
2. 带 `completed_empty` / 零证据 marker（`DIAGNOSIS_CODES` 闭集语义，与 `runs diagnose` 同一投影）；
3. 证停新鲜度前提成立。终态后 settle 重读成功（`stopRereadOk`）是两臂的共同前提——重读失败时旧快照的证停可能已被其后落盘的未证停事实压掉，两臂全关不重派。重读成功后：默认严格臂要求 `run.stop_verified`（运行时的静默探针确认了 worker 已停）；类别臂是显式 opt-in 启发式（`--allow-process-death-inference` 且无显式 `run.stop_unverified` 事实）——它依据的 backend 类别是注册表层的类事实，不证明本 run 进程已退出。

不变量：绝不中止或重试在飞的 run（派发走后台分离 + 独立观察窗，不挂 `--wait-timeout`——该窗到期只通知不杀，活性判定归本脚本自己的谓词）。零产出不等于没在工作：纯调研零写入合法，观察窗内活跃即继续等。纯函数面钉于 `test/registry-roles/dispatchLiveness.test.js`。

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

工作树检出的是源仓库 HEAD 里已提交的版本（MCP 派发时是派发前证明过的那个提交）：已跟踪的文件以提交时的内容出现，Lead 工作区里未提交的改动和未跟踪的文件都不在里面。要 worker 看到，先提交。

WAO 在创建首个 worktree 前，会在仓库本地 `.git/info/exclude` 写入恰好一条根忽略规则 `/.wao-worktrees/`，使持久 worktree 目录不出现在源工作树的普通 `git status --porcelain` 输出。这是一条稳定 repository-local hygiene 规则：不编辑 tracked `.gitignore`、不隐藏任意 worker 产出，worktree 删除后仍保留。WAO 保留既有 exclude 字节（含 BOM、CRLF/LF、用户规则），对已存在的精确规则幂等。`git worktree add` 失败时保留该稳定规则、不回滚——规则只在 exclude ensure 自身失败（write/read-back verify）时回滚到调用前字节。该规则与 host activation（如 Codex `mcp bind`）的 marker block 互相独立，移除一个不会影响另一个。

## 场景 5：重试 / 恢复

```powershell
# 重试：用原 run 的 prompt 重新跑一个新 run
npm run cli -- retry <runId> --wait

# 重试时替换源 run 的 per-dispatch 覆盖（显式 flag 优先于继承值）
npm run cli -- retry <runId> --model <id> --reasoning <effort>

# 恢复：接续一个未完成的 run
#   opencode-serve：attach 到已有 session
#   claude/codex：重放原 prompt（进程式无法 attach，只能重放）
npm run cli -- resume <runId> --wait
```

resume 的两种姿态：

- 不带 `--wait`（detached runner 托管）：CLI fork 一个 detached 的 resume runner 后立即返回。runner 拥有续跑 handle，驱动 waitForCompletion（token 闸门 / 等待窗到期通知 / 自然终态）并写 ownership 心跳（daemon `--resume-on-start` 判活不劫持）。监督走 `runs status` / `runs wait`。CLI 侧先做廉价的终态与权威事实预检（bound findState + 首条绑定 `session.created` / `run.started` / `prompt.sent`——最后一项是进程重放所必需，缺失会在 fork 后被 runner 静默拒绝），已终态或不可续接的 run 直接打印既有拒绝形状（`resumed:false`），零 fork；预检与 runner 内权威 resume 之间的竞态由 runner 兜底。fork 后的失败不回传父进程（detached 语义）：runner 会向本 run 转录追加持久失败事实（`run.error`，phase=resume——恢复抛错或被拒两路都落盘，固定安全文案），监督侧用 `runs status` / `runs tail` 复核，不要只信 `resumed:true`。
- 带 `--wait`（前台等待）：CLI 进程持有续跑 worker，等到自然终态；等待窗到期同 `run` 前台（通知不杀）。本进程退出或被杀时 worker 被 Windows Job Object 连坐终止——这是进程隔离机制的设计行为（见[安装与配置](install.md)的 Node v22 一节），不是缺陷；要存活就不要用前台姿态挂着不管，用托管续跑或 `--background` 派发。

retry 的 per-dispatch 覆盖继承（任务文本 runId 绑定取法、继承范围、坏持久化值 fail-closed、`--model` / `--reasoning` 替换 flag、reuse 形状与全新 provider session 边界）见 `docs/certification-runbook.md` §retry 的 per-dispatch 覆盖继承（单向链接；唯一权威）。

## MCP `run_dispatch`（受监督的后台派发）

`run_dispatch` 让 MCP host 正式派发一个受监督的后台任务。它直接复用与 CLI `run --background` 相同的 application service（`dispatchRun()`），不 shell-out CLI。WAO 拥有 dispatch、detached runner 和 transcript；模型只提供 worker 和 bounded prompt。

参数与形状见 `docs/surface/mcp-tools.md`（生成层，随代码再生成）。输入是 strict schema（拒绝额外字段）；schema 未列的一切（`registryPath`、`runDir`、`runId`、`cwd`、`workspaceRoot`、`requireCertified`、timeout、`isolate` 等）都是 server-owned 配置，模型不能传。

角色合同自动注入：Lead 只写具体任务 prompt，无需复制角色说明，也无需切换到 WAO 仓库目录。角色在派发时选择：CLI 写 `run --lane <车道> --role <角色>`，MCP `run_dispatch` 给 `lane` + `role`；这一形式与 `agentId` 二选一，混用以 `dispatch_selector_invalid` 拒绝。合同取自角色库 `config/roles/<角色>.md`。只给 `agentId` 时：它若是车道别名（`config/lanes.json` 的 `aliases`），按别名声明的角色取合同；否则沿用该 registry 条目的 `systemPrompt`。入库的别名表为空，模板条目也不带 `systemPrompt`，所以按车道名派发不注入角色合同。WAO 用共享加载器（`roleContract.js`）验证合同，按各 backend 的原生通道恰好一次注入 worker；各 backend 的注入方式见生成层 `docs/surface/certification.md`（supportsRoleContract 一列与条件说明）。相对路径由加载器相对 WAO 安装根解析（不依赖调用者 cwd），从外部项目目录调用也能找到角色文件。是否支持注入由 backend 能力声明（`supportsRoleContract === true`）严格判定；能力值非严格 true 时，请求了角色或配了 `systemPrompt` 的派发会在 start（创建 transcript 前）/ resume（读取既有 transcript 后、append/spawn 前）fail-closed。WAO 不把角色合同保存为 `prompt.sent` / 控制面输入——transcript 只持久化原始 task prompt（worker 输出可能在回答中引用或复述角色，这由模型决定）。Lead/model 不能通过 `run_dispatch` 覆盖角色（strict schema 不接受 `systemPrompt` / `roleContract` / `rolePath`）。

Kimi K3 模型策略：registry 用结构化 `model.id` 与 `reasoning.effort` 表达每个 worker 的模型策略。`kimi-code/k3` 的 `low` / `high` / `max` effort 由 backend 编译为仅对子进程生效的 `KIMI_MODEL_THINKING_EFFORT`；WAO 不修改全局 Kimi 配置，也不接受同名 `agent.env` 作为第二权威。K3 的上下文上限来自 Kimi Code 模型目录（当前 1M），不是 WAO 的进程级 override，因此 registry 不重复声明 `model.contextWindow`。kimi-web 车道的 `reasoning.effort`（车道声明或单次 `--reasoning` 覆盖）原样作为每次提交（含 resume 轮）的 `thinking` 字段发给 serve，不配则不发；可用档位见生成层 `docs/surface/certification.md`，型号与力度的搭配由 serve 校验，不支持的组合派发失败。

kimi-code 与 deepseek-harness 两个后端当前暂停使用（为什么见决定 0074）；车道状态与配方见[车道](lanes.md)。

可选 `delivery` 块（嵌套形状以 wire 为权威）用于派发后续可由 `run_delivery` / `run_delivery_decide` 操作的 delivery run：

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

`delivery` 可选。`verificationCommands` 与 `verificationUnavailableReason` 二选一（互斥）。WAO 强制 persistent worktree isolation——模型不能传 `isolate`（隔离不是可选输入）。delivery run 的包容在未声明 OS 写沙箱的车道是侦测不是沙箱（写后侦测非写前阻止；codex 车道例外——见 `docs/02-architecture.md` §4.6）。registry certification 的定位（advisory 证据、非 permission gate、显式 CLI `--require-certified` opt-in 门与 MCP 差异）见 `docs/certification-runbook.md` §认证与当前就绪（单向链接；唯一权威）。

单条 verification 命令的执行预算（可选 `verificationTimeoutMs`）：整数 ms，共享闭界 `[1000, 7200000]`，默认 300000 仅在字段缺失时应用。它不是 `run_wait` / `run_await_result` 的观察窗口——它约束 exact verifier 的逐条 setup/assertion 命令执行。语义：

- 验证先于副作用：非法值（字符串/小数/越界）在派发/start/resume 的任何 transcript append、worktree 创建、spawn/attach、打包、验证之前经 `prepareDeliveryRequest` SSOT 拒绝（`invalid_verification`），零转录、零 worktree、零 spawn。
- 零漂移：仅在显式声明时持久化（`run.started.delivery.verificationTimeoutMs`、`delivery_created` ref、verification outcome ref 都保留该值）；未声明则任何事件/ref 都不出现该字段，消费者才用默认值。
- 持久值权威：贯穿 start / resume（resume 重新经 SSOT 校验，持久值损坏则 resume 直接拒绝）、profile 折叠（profile 只供命令，Lead 声明的预算保留）、MCP/CLI 转发、`run_dispatch_contract_check` advisory 校验、`run_delivery_repackage` 原值重建与 verifier 调用、reverify 继承（省略 `timeoutMs` 时继承 ref 上持久化的预算，持久值损坏则 fail closed；显式值同样必须落在共享闭界内）。repackage 中字段缺失仍交给 verifier 默认值，字段存在但损坏则在 inventory/Git/transcript/verify 前拒绝。
- 无自动动作：从不自动加宽、从不重试、从不因超时自动 stop/decision——超时结果如实投影为闭集 `command_timeout` / `setup_timeout`。

continuable 续谱根（delivery-only 可选）：`run_dispatch` 顶层可带 `"continuable": true`（与 `delivery` 同级，不在 delivery 块内），把这次 delivery 标记为一条可续谱系（continuable lineage）的根。dispatch 以 `run_lineage` / `turn:first` 建立 provider-native 会话（opaque uuid 由 server-owned Lead session + 本次调用的目标 cwd + canonical agentId + 该 run 的 rootRunId 派生），保留 retained worktree。日后 Lead 审阅该终态 delivery、发现窄缺陷，可用 `run_continue` 对其续一个修正回合（见下节）。若 runtime 在 wire 上广告 native 会话 id（kimi `session.resume_hint` / codex `thread.started`），该 run 会在终态前记为 `run.provider_session_bound`（`session.created` 仍唯一 `proc_<pid>`），供 `run_continue` 取回真实会话续接。`continuable` 默认 `false`，省略时与普通 delivery dispatch 字节兼容；`continuable:true` 必须配 `delivery`（service 强制 delivery-only，否则 fail-closed）。WAO 从不在 dispatch 时推断或触发任何续跑——是否续跑完全由 Lead 事后显式调用 `run_continue` 决定。

`continuable` 的后端资格以后端类声明（`supportsSessionReuse`）为准——人读投影见生成层 `docs/surface/certification.md` 能力列（registry 的 `sessionReuse` 条目是路由配置，不是能力证明）。资格拒绝携带固定原因码 `continuable_backend_unsupported`，缺 delivery 拒绝携带 `continuable_delivery_only`（固定文案，不回显席位/workspace/backend 名）。

只读声明（可选 `readOnly`）：`run_dispatch` 顶层可带 `"readOnly": true`（CLI 等价 `run --read-only`）。声明链路是"声明 → 强制隔离 → 观察"：`readOnly` 强制隔离——非复用轮是 ephemeral 私有克隆（席位默认作用于当前仓库的 git 写入落在克隆里、不进源仓；停止确认且没有新提交才删，规则见[架构](../02-architecture.md) §4.3①）；sessionReuse 复用轮是 persistent 链接工作树（kimi 会话 server 侧 cwd 钉在首轮树）；建树失败时 fail-closed 拒绝派发（typed `read_only_worktree_required`，不走普通 run 的降级原 cwd 路径）。start 时恰一次写入 `run.read_only_declared` durable 事实（事件表见[transcript 格式](transcript.md)），之后 `run_activity` 在快照含该声明时附带 advisory `readOnlyObservation`（见[监督](supervise.md)的 `run_activity` 一节）。`readOnly` 与 `delivery` 块互斥（拒绝文案携带闭集理由码 `read_only_delivery_conflict`；CLI 侧 `--read-only` × `--delivery-spec-file` 同样拒绝）；与 `correctable` 可共存（correction 是 Lead 显式指令，声明与观察并存）；`readOnly` × `continuable` 被既有 delivery-only 门自然拒绝。诚实上限：① 观察基于 worker 工具上报的 `file_written` 证据（`no_writes_observed` 的含义是"未观察到写"，不是"没写"），不是全知监控；② 强制隔离与越界侦测在未声明 OS 写沙箱的车道是侦测机制不是 OS 沙箱——降低误写面、不物理阻止（codex 例外见本页 delivery 一节）；③ 观察是 advisory 非门——观察到越界写不会自动停止、不会失败、不改写 run 的自然终态，终审归 Lead。与 `wao ask` 的 prompt 级只读边界（快捷派工默认注入的只读提示词）是两回事：那是不可验证、无持久事实的 prompt 约定；控制面 `readOnly` 声明有 durable 事实事件 + 基于上报证据的观察投影。

单次模型覆盖（`model`）与单次推理力度覆盖（`reasoning`）的 MCP 特有规则见 `docs/certification-runbook.md` §场景 1b / §场景 1c（与 CLI 覆盖正文合并维护；单向链接；唯一权威）。

verification 环境合同：可选声明 `verificationSetupCommands: string[]`——在 assertion 命令（`verificationCommands`）之前顺序执行的环境准备命令（如 `npm ci` 安装依赖、生成构建产物）。setup 与 assertion 分开验证、持久化与投影：setup 失败投影为闭集 `setup_failed` / `setup_timeout` / `setup_environment_error`，绝不伪装成 assertion 的 `command_failed`，不泄漏命令体/路径/stderr。每条 setup 与每条 assertion 之后都重做 exact delivery commit / 受跟踪工件证明，任何 tracked artifact 或 lockfile 漂移 = `artifact_mutated`（setup 漂移时 assertion 不执行）。exact-artifact verifier 运行在独立的 per-attempt 临时环境：每次 setup / assertion 命令各创建唯一 temp 目录并注入 `TMP` / `TEMP` / `TMPDIR`，两个 attempt 不复用、不复用 worker temp，仅持久化安全布尔事实（不含绝对路径）。依赖不继承：selected / worker worktree 的 `node_modules` 等 ignored / untracked 依赖不会自动出现在 exact verifier 环境——需要 Lead 声明 `verificationSetupCommands` 来准备。

派发目标只来自本次调用：`run_dispatch` 必传 `expectedWorkspaceRoot`（本项目 Git 顶层的绝对路径），经 `proveWorkspace` 证明——缺参或证明不过都在副作用前拒绝（零副作用）。证明后的 canonical Git root 用作 worker `cwd`、后台 runner `--cwd` 与转录归属；`expectedGitHead`/`expectedDirty` 仍可选断言。会话选择、MCP roots、`--workspace-root` 不参与派发目标（只作只读缺省范围）。

输出（成功/拒绝同形，MCP `content` + `structuredContent`）：字段清单见生成层。返回的 `agentId`（transcript envelope 盖戳的 canonical worker 身份）必须精确等于请求的 `agentId`——这是控制面对派发的身份绑定，不允许"合法但属于另一个 worker"的 id、missing/unknown/非法值；mismatch 一律折叠为固定 `run_dispatch failed`（`isError:true`、无 `structuredContent`、不泄漏返回值）。`run_dispatch` 永不返回 `"unknown"` 哨兵（那是 read 类工具的降级值）。不返回绝对路径、PID、prompt、argv 或内部错误。service 失败时返回固定安全文案 `run_dispatch failed`，不拼接原始 exception message、stderr、路径或凭据。

`providerSessionRouting` 是闭集 `"not_used" | "first_turn_requested" | "resume_requested"`，描述本次派发的路由请求真相，不是 provider 会话成功/建立的证明。派生仅来自 `dispatchRun` 内部已选定的路由回合（`routing.turn`）：普通一次性派发（含普通 delivery 的 `lead_workspace` 复用——该复用是有意不使用 provider session）为 `not_used`；reusable expert 首轮 / continuable delivery 根首轮为 `first_turn_requested`；reusable expert resume / continuable 续接为 `resume_requested`。`accepted:false` 早返回恒为 `not_used`。绝不暴露 routing mode、opaque session uuid、Lead id、workspace path、argv 或 provider payload——这些是 server-owned 内部细节。provider 是否真正 resume 成功由后续 `run_status` / `run_await_result` 的传输与终态证据决定；WAO 不据此自动决定路由、不自动重试、不自动 stop。

CLI 前台 `run` 派发复用型专家时，显式给 `--cwd <目标项目的 git 根>`：复用身份含本次调用的目标 cwd（见 `docs/02-architecture.md` §4.10），cwd 不同就接不上上一轮的会话，要重新派发。

reuse 路由对前任 run 的判定是 runId 绑定读取：`session.created` 存在性检查（决定 busy/resume/first 分派）与终态判定（`findState`）都只由前任 run 自身事件计算——尾部追加的外 run 伪造行不能把 crashed 前任翻转成 resumable，不能把在飞前任翻成 resume，也不能把终态前任伪造成在飞而阻断派发。前任 transcript 为信封前 legacy 格式（事件无 `runId` 字段）时，reuse 路由从 resume 降级为 first（认领槽位开新回合，不复用无法归属到前任 run 的会话）；全无信封的前任 transcript（零绑定事件）按 busy 处理（不可归属 = 永不并发驱动同一 provider 会话）。

返回时 transcript 已可读且为 `pending`；关闭 MCP host 后，detached runner 独立驱动 worker 到自然终态（token 闸门 / 等待窗到期通知 / 兜底 abort 都生效——到期不杀），写入共享 transcript。Lead 结束回合前按返回的 `nextStep` 挂好等待，`run_status` 只做即时查询。

## MCP `run_continue`（Lead 授权修正续跑）

`run_continue` 让 Lead 对一个终态 continuable delivery 续一个修正回合。典型场景：Lead 审阅一个 delivery、发现窄缺陷（如一个漏改的边界条件），显式授权一次修正——WAO 创建新 run/transcript，复用父 run 的 retained worktree（不开新 worktree、不开新 provider 会话），以 `turn:resume` 续同一 provider-native 对话，并打包新的 child delivery。MCP adapter 直接委托 application service `continueRun()`，不 shell-out CLI；没有对应 CLI 子命令。

Lead 语义唯一，WAO 不推断：correction 的存在、范围、verification、retry、acceptance 全部由 Lead 决定——`run_continue` 只在 Lead 显式调用时发生一次，从不自动续跑、从不扩大范围、从不自动重试/接受/拒绝。child delivery 的 review/accept/reject 仍走 `run_delivery_review` / `run_delivery_review_bundle` / `run_delivery_decide`，归 Lead。

续谱作用域：复用的是这一条谱系的 provider 会话——opaque uuid 由 server-owned Lead session + canonical workspace + canonical agentId + root runId 派生，跨一条 lineage 复用。它与 `lead_workspace` expert 复用是不同的 routing 模式（`run_lineage` vs `lead_workspace`），互斥：`continuable` 是 delivery-only，`lead_workspace` 是非 delivery。

参数与形状见 `docs/surface/mcp-tools.md`（生成层，随代码再生成）。输入是 strict schema：`parentRunId` + `prompt` + 必填的子 `delivery` 块 + 必传的 `expectedWorkspaceRoot`（父 run 必须属于它；嵌套形状以 wire 为权威）。

`parentRunId` 必须是一个终态且 `continuable` 的父 run（其 `run_dispatch` 顶层带了 `continuable:true`）。已 accepted 的父 delivery 不可续；Lead 应为已接收成果另建新 run。`delivery` 必填（续跑总是 delivery run，child 会从谱系原始 baseCommit 打包累计 candidate，而不是只打包本轮 correction delta）。因此 child 的 `allowedPaths` 必须覆盖父 retained 成果的全部累计 changed paths（父成果 + 本轮修正）；WAO 不会替 Lead 推断或扩展范围。这一覆盖关系在 read-only 资格阶段即被核对：`run_continue` 从权威 Git/worktree 事实派生父 retained worktree 中仍存在的实际变更，复用既有 containment SSOT（`isPathAllowed`，segment-boundary 语义）与既有 inventory 上限，在任何 mutation 之前与 child `allowedPaths` 比对。若存在未被覆盖的继承路径，`run_continue` 以 `continuation_scope_incomplete` 拒绝，并返回有界的仓库相对事实（`inheritedChangedPaths` / `inheritedChangedCount` / `inheritedChangedTruncated` 与 `uncoveredInheritedPaths` / `uncoveredInheritedCount` / `uncoveredInheritedTruncated`，已排序去重、按既有 inventory cap 截断），供 Lead 显式批准累计范围后重试。WAO 绝不自动扩展范围、自动恢复文件、重试或接受，也不暴露绝对路径、prompt、command、provider/session 数据或任意 Git 错误。一个被授权用于 correction 的路径随后可被 restore 回 base 并从最终 delivery 中消失——WAO 不解读该语义选择；child 自身最终 diff 仍由既有 packaging containment 闸门（`disallowed_path`）治理，本检查未削弱 packaging。模型不能传 registry/runDir/cert——server-owned。

资格检查（read-only，先于任何 mutation）：WAO 在 claim 续谱槽 / 转换 worktree / 写 transcript / fork 之前，以 closed-set `rejectionReason` 拒绝不合格的续跑：`malformed_input` / `invalid_delivery` / `parent_not_found` / `parent_not_terminal` / `parent_accepted` / `lineage_closed`（Lead 已显式关闭该线系）/ `not_continuable`（父 run 非 lineage 续谱根，legacy 不可续）/ `no_provider_session` / `workspace_mismatch`（父 run 不属于本次调用给出的项目）/ `no_delivery`（父 run 缺 delivery 上下文）/ `worker_configuration_changed`（当前 backend/model/provider 配置已不同——比对父 run 的 `run.started.providerKey` 接入方指纹，凭据不入比对；父为显式 `null` 而 registry 现配 provider 块则拒，legacy 父无该字段则跳过该维）/ `role_contract_drift`（父 run 钉住的角色正文与当前文件不一致或无法加载）/ `legacy_dispatch_continuable_unsupported`（父 run 的 agentId 是重键之前的席位名）/ `unsupported_backend`（backend 未声明 session reuse）/ `missing_worktree` / `worktree_drift`（retained worktree 丢失或 base/分支漂移）/ `continuation_scope_incomplete`（child `allowedPaths` 未覆盖父 retained 累计变更）/ `busy`（同一谱系已有非终态 owner 在跑）。静态 argv 与 credential 检查也在 mutation 前完成；开始转换后若 transcript 或同步 spawn 失败，WAO 机械恢复父 worktree、删除 orphan child transcript 并释放谱系 claim。第二次 worktree 证明若发现外部漂移，只报告事实，不覆盖外部状态。这些 closed-set refusal 是正常结构化结果（`accepted:false` + `rejectionReason`），不是 MCP error；环境/内部执行错误仍保持既有固定安全错误边界。

`no_provider_session` 覆盖完整可续接检查：在 registry 身份与 backend 支持检查之后、claim/worktree/child transcript/spawn 之前，`run_continue` 用与 spawn 权威（`RunManager.start`）相同的共享读取器 + backend 可用性钩子判定父转录是否持有该 backend 可续接的真实 provider 会话 id。kimi/codex（会话 id 由运行时自产、只在 wire 上广告）的父 run 若只记录了进程占位身份（`session.created.backendSessionId=proc_<pid>`）而无 `run.provider_session_bound` 绑定事实，则 `no_provider_session`，零副作用；带有效绑定事实则续接使用真实 native id。claude-code 父 run 的 proc-only 形状照常可续接（其 resume 编译路由 opaqueUuid `--resume <uuid>`，从不消费取回 id）；ACP 的 native `session.created` 语义不变。早于绑定事实落盘的 Kimi/Codex proc-only 父 run 不可续接（不迁移旧数据）。

输出（成功/拒绝同形，MCP `content` + `structuredContent`）：字段清单见生成层。成功返回新 child 的 dispatch 身份 + 谱系事实（`parentRunId` + `continuation:true` + `rootRunId`）。拒绝时 `accepted:false`、`rejectionReason` 为闭集码、其余成功字段为 `null`；`continuation_scope_incomplete` 是唯一额外携带累计范围事实的拒绝形状，供 Lead 显式批准后重试——有界仓库相对字段（`inheritedChangedPaths` / `inheritedChangedCount` / `inheritedChangedTruncated` 与 `uncoveredInheritedPaths` / `uncoveredInheritedCount` / `uncoveredInheritedTruncated`）仅在该拒绝码中出现，成功与其余拒绝均不携带；任何畸形/不安全路径在该字段投射时 fail closed 为整体省略（闭集 reason 仍保留），绝不泄漏绝对路径或 Git 错误。`busy` 只回 label，不回 active runId——opaque provider uuid、Lead id、workspace 路径、active lineage runId、transcript 路径永不出现在 MCP 输出（与 `run_dispatch` reuse-busy 脱敏合同一致）。

retained-worktree 转换（幂等、崩溃安全）：把父的 retained worktree 重新钉到 base 上、切到 child 分支 `wao/<childRunId>`，把父的 delivery/candidate 字节保留为 unstaged 工作改动；父 commit 对象永不删除，仍可按 SHA 审阅。child 从 base 打包自己的 delivery。

目标必传 `expectedWorkspaceRoot`；父 run 不属于它即 `workspace_mismatch`（`run_collect`/`decide` 用同一核验，以固定文案拒绝）。归属核验比 cwd 规范路径、不看桶名：只有 `_unattributed`（cwd 缺失/相对/无法解析）与无归属事实的旧转录一律被拒；`_sandbox`/`_scratch` 里的有效 Git 顶层给出同一路径即可过。

## MCP `run_correct`（运行中显式纠正）

`run_correct` 让 Lead 对一条仍在执行、且派发时显式声明 `correctable:true` 的 run 发送一条有界纠正消息。它与 `run_continue` 不同：`run_correct` 不创建 child run、不切换 worktree、不重新派发 worker，而是把 Lead 明确提供的纠正写入原 run 的 durable transcript 队列，再由原 runner 串行投递给同一 provider 进程。普通 `run_dispatch` 省略 `correctable` 时保持原行为；backend 未声明 in-flight correction 能力时，`correctable:true` 在创建 run 前 fail closed（固定原因码 `correctable_backend_unsupported`；能力列见生成层 `docs/surface/certification.md`）。

输入是严格对象：参数与形状见 `docs/surface/mcp-tools.md`（生成层，随代码再生成）。`correctionId` 为 1..64 字符的 `[A-Za-z0-9_-]` 幂等键，`prompt` 为 1..15000 字符。相同 `correctionId` + 相同 prompt 可安全重查；同一 id 配不同 prompt 固定拒绝。目标必传 `expectedWorkspaceRoot`（run 必须属于它）；run 须处于 submitted/running 阶段；pending 尚未可投递，终态 run、未 opt-in run、跨项目 run 或不支持的 backend 均返回闭集拒绝事实，不自动 retry、stop、continue 或改状态。

输出 `outcome` 是 `queued | pending | delivered | rejected` 的闭集。语义逐层区分：

- `queued` 只证明纠正已 durable append，等待 runner claim；
- `pending` 表示已有请求但尚无可确认的最终投递事实；
- `delivered` 只证明字节已送入 provider stdin，不证明模型已读取、理解或执行；
- `rejected` 携带闭集 `reason`，不回显 prompt、provider payload、session、路径或内部错误。

runner 以 requested → claimed → delivered/delivery_failed 的 durable 事件链串行处理；`run_activity` 只暴露安全的 correction 生命周期状态，不返回纠正正文。WAO 不判断纠正内容是否合理，也不会据此扩大 `allowedPaths`、改 verification、自动停止或接受交付；这些语义和最终决策仍完全属于 Lead。
