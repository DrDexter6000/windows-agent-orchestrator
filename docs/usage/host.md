# 接入宿主与绑定项目

> [使用手册](../usage.md)的一页：把 WAO 的 MCP 服务注册进宿主（Claude Code、Codex、OpenCode），并把会话绑定到一个项目。

## MCP stdio 接口

WAO 是 MCP-first 控制面（为什么见决定 0017）：一个 MCP host（如 Claude Desktop、Codex、OpenCode、其它 agent runtime）可通过 stdio 把 WAO 当作 MCP server 调用，CLI 是 fallback。每个工具直接调用共享 application service，不 shell-out CLI。工具计数、参数与形状不在本页维护，见生成层 docs/surface/mcp-tools.md；当前工具清单的权威表见 `SKILL.md` 与 `docs/02-architecture.md`。

常用 Lead 闭环：`registry_list`（inventory）→ `workspace_status` / `workspace_select`（或一次 `lead_preflight`）→ `run_dispatch` → `run_await_result`（等终态）→ `run_delivery_review_bundle`（审查）→ `run_delivery_decide`（验收）。原子观察工具（`run_status` / `run_wait` / `run_collect` / `run_activity` / `run_diagnose`）、delivery 查询与审查、`run_stop` / `runs_list` 恢复、Lead 授权的 `run_continue` / `run_correct`，各工具的完整语义按任务分页：[派发](dispatch.md)、[监督](supervise.md)、[取结果与查历史](results.md)、[交付与验收](delivery.md)、[会审](consult.md)。

`run_await_result` 是 advisory 只读便捷工具：一次调用等待终态（waitMs 区间与默认值见生成层；`waitMs:0` 为 point-in-time 读取）后返回安全 compact 结果与 run/liveness 观测，非终态时可按任意合法 waitMs 再调。`waitMs` 约束工具主动 sleep/poll 的总等待预算，不是给每个内部阶段各分配一份；本地 transcript 文件读取与同步 snapshot 投影不能在 JavaScript 执行中途抢占，极端存储停顿可能让实际墙钟略超预算——工具不把这种环境延迟谎报成 worker 失败。观察窗口、终止事实、读失败与 transport 恢复的完整语义见[监督](supervise.md)；终态附带的有界 `outcome` 捆绑（terminalState / diagnosis / delivery 安全事实，不含 commit id、changed paths、diff、command 文本或绝对路径）见生成层，其中 `outcome.delivery.isolationFailureCode` 的语义见[交付与验收](delivery.md)。

built-in playbook catalog 不在工具面：它是按需读取的 MCP resources（`wao://playbooks`），见[取结果与查历史](results.md)。

**Host 注册说明**：

- `npm run mcp` 仅用于在 WAO repo 内手工 smoke；正式 host 注册应指向 Node shim 和 stdio entrypoint 的**绝对路径**，并为 registry 和 runDir 指定绝对路径——MCP host 的启动 cwd 不保证是 WAO repo。host 配置语法由 host 自己负责。
- 注册后若当前会话未发现工具，重启或重载 host。
- Provider credential 必须由 host 通过其安全 env inheritance/allowlist 提供。不把 credential value 写入 repo、worker prompt 或 MCP args。WAO 不接管 host-global auth。

在 WAO repo 内手工 smoke（所有生产入口走 Node v22 shim）：

```bash
npm run mcp
```

MCP host 的 stdio 配置（使用绝对路径占位符，替换为你的实际 WAO 安装路径）：

```json
{
  "mcpServers": {
    "wao": {
      "command": "node",
      "args": ["C:\\path\\to\\wao\\scripts\\wao-node.cjs",
               "C:\\path\\to\\wao\\src\\mcp\\stdio.js",
               "--registry", "C:\\path\\to\\wao\\config\\agents.json",
               "--run-dir", "C:\\path\\to\\wao\\runs"]
    }
  }
}
```

### OpenCode 项目级配置（host-local）

OpenCode（`opencode-ai` npm 包，不是已废弃的 `opencode`）作为 MCP Lead host 时，**项目级配置写在目标项目根目录的 `opencode.json`（或 `opencode.jsonc`），不写在 WAO repo**。本地 MCP schema 与上面的通用 JSON 不同：`command` 是**单个字符串数组**（可执行文件 + 全部参数都在数组内）。

在**目标项目**根目录创建 `opencode.json`（路径用绝对占位符，替换为你的实际安装路径；不要写本机真实 credential 或用户目录）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "wao": {
      "type": "local",
      "enabled": true,
      "command": [
        "node",
        "D:/absolute/path/to/wao/scripts/wao-node.cjs",
        "D:/absolute/path/to/wao/src/mcp/stdio.js",
        "--registry",
        "D:/absolute/path/to/wao/config/agents.json",
        "--run-dir",
        "D:/absolute/path/to/wao/runs",
        "--workspace-root",
        "D:/absolute/path/to/target-project"
      ]
    }
  }
}
```

要点：

- `command` 必须是数组（`["node", "<wao-node.cjs 绝对路径>", "<stdio.js 绝对路径>", ...]`）。写成单个字符串会被拒绝。第一项是 `node`，第二项是 v22 shim `scripts/wao-node.cjs`（避免系统默认 node 是 v24 触发 WAO versionGuard），第三项起是 stdio entrypoint 与 server-owned 参数。
- `enabled` 是 OpenCode **optional** 配置（官方 schema 不强制）。显式写 `"enabled": true` 可消除配置继承歧义、避免被父配置或全局默认覆盖；省略不必然导致禁用（实际行为取决于 OpenCode 版本与继承链）。
- `--workspace-root` 指向**目标项目**根，不是 WAO repo。这是 host-bound workspace binding；`run_dispatch` 会在调用 shared service 前重新证明 workspace，并以 canonical Git root 作为 server-owned `cwd`。
- 这是 host-local 配置，含绝对路径时**默认不建议 commit**；Owner 可把它放进 `.git/info/exclude`（本地忽略，不污染 `.gitignore`）。
- **验证**：在**目标项目**根执行 `opencode --pure mcp list`，期待看到 `wao connected`。`--pure` 会禁用 OpenCode 插件（如 oh-my-openagent），用于排除插件干扰；它**不**保证禁用全局 MCP 配置，也不自动移除全局 MCP。
- **重启边界**：修改配置后，**必须启动新的 OpenCode 进程**。`opencode --pure mcp list` 显示 `wao connected` 不等于已运行的旧进程工具已热加载——旧进程仍看不到 WAO tools。
- **不要无交互使用 `opencode mcp add` 配 local stdio**：该子命令对 local stdio 是交互式入口，不是稳定脚本路径。直接维护上面的项目级 JSON。

## 冻结工具面（always-registered tools）

WAO 的 MCP 工具**全部始终注册**：没有 profile、没有启动 flag，连接期间每个工具都能独立调用，宿主不必重启就保有全部能力。它不按宿主名分支，也不是权限层；各宿主的接入通路与能力在 `src/hostAdapters/hostDescriptors.js` 的冻结描述符表里，表外宿主用 host-neutral 片段接入。工具名单、契约哈希与描述字节上限怎样冻结，见 `docs/02-architecture.md`「冻结工具面」与决定 0021。

渐进式披露：观察类工具的输出统一携带 `availableDrilldowns`（≤4 条静态提示，闭集成员都在冻结工具面内），只披露可安全调用的观察工具，不自动调用、不广告 mutation/control 工具。详见[取结果与查历史](results.md)。

`run_dispatch_contract_check` 是 advisory 只读预检，与 `run_dispatch` 共享输入 schema（service 复用同一 application 校验），返回闭集 workspace/registry/contract 视图与有界 issue 码。`contractValid` 只反映 delivery/profile 的机械合同，不预评 `expectedGitHead`/`expectedDirty`/`expectedWorkspaceRoot`，也不预评 continuable/backend/session 资格或 worker 凭据；sections 独立 settle 为 `observed`/`unknown`，零副作用——它不是门禁，`run_dispatch` 不依赖它，其部分失败不影响派发。它同样**接受**顶层 `readOnly` 字段但**不评估**它（只读是派发声明，不是 delivery 合同维度）。`run_dispatch` 的可选顶层输入 `executionProfileId`（与 `delivery` 同级）取自冻结可信 profile catalog，仅提供 delivery 验证的 setup/assertion 命令，与 inline `delivery.verificationCommands` / `delivery.verificationSetupCommands` / `delivery.verificationUnavailableReason` 互斥，派发前解析；未知或冲突的组合由共享 resolver 稳定拒绝。派发细节见[派发](dispatch.md)。

legacy argv 兼容：stdio argv parser 把任何残留的旧 profile 参数视为**普通未知 flag** 忽略——不解析值、不出现在解析输出、不改变 server 面、不失败启动；`--registry`/`--run-dir`/`--workspace-root` 解析与 fail-closed 语义不变。既有 Host 配置无需任何迁移。

## MCP `registry_list`（worker 清单）

只读操作。参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入无参数——`registryPath`/`runDir` 是 server 启动配置，模型每次调用不能覆盖。输出为 MCP `content`（text = JSON）+ `structuredContent`（同义对象）；`agents` 元素语义与 CLI `registry list --format json` 的数组元素一致（MCP 仅多一层 `agents` 包装）。调用前后 runDir 不会有新增 transcript/run 文件。

registry 源可读但某条目无法 normalize/project 时，走**部分投影**：有效 worker 照常返回，另附有界安全的逐条 `issues`，而非整表失败。`issues` 元素形状固定为 `{ "code": "invalid_id" | "invalid_configuration", "agentId": "<canonical id>" | null }`：`invalid_id` = id 非 canonical；`invalid_configuration` = canonical id 但 backend/cwd/model/provider/sessionReuse/waitTimeout/systemPrompt 校验失败。`agentId` 仅当 id 为 canonical 时投影，否则为 `null`（绝不回显原始 id）；`issues` 绝不携带原始 error 文本、配置、路径或凭据值。条目数上限 32（`REGISTRY_ISSUES_CAP`），超限设 `issuesTruncated:true`（真实 malformed 数无界）。零有效 worker 但有 issues，不等于观察干净的空 registry。WAO 不据此自动停止派发、不自动换 worker、不把坏条目标记为 healthy。

整表源不可读或非法 JSON 是另一类失败：`registry_list` 直接返回固定 error（`lead_preflight` 则 `checkStatus.workers:"unknown"`、`workers:null`），绝不伪造成部分结果。registry 源每次 MCP 操作只读/解析一次，`lead_preflight` 复用同一快照。严格的 registry 维护路径（CLI `registry validate` / `registry list` 遇首条坏条目即抛错）与这一投影是分开的。

认证与就绪字段的语义（`certificationReasonCode` / `certificationLastHealthyAt`、凭据可用性 `credentialAvailability`、`providerReadiness`——历史认证与当前凭据、授权、容量的区别）见 `docs/certification-runbook.md` §认证与当前就绪（唯一权威）。

## MCP `workspace_status`（绑定状态查询）

`workspace_status` 查询当前 workspace 绑定状态，输入是 strict empty schema（拒绝任何字段）。`run_dispatch` 在执行前**自行重新证明** workspace，不信任此工具的先前结果。

`source` 的三个取值对应三种 workspace authority，优先级从高到低：`"lead_session"`（Lead 会话选择，见 `workspace_select`）> `"mcp_root"`（client roots/list）> `"server_config"`（显式 `--workspace-root`，全局静态启动参数）。`workspaceRoot` 是当前绑定的 canonical Git 顶层绝对路径（Lead/host 已显式提交，非 credential，故返回）；`bound=false` 时其余字段均为 `null`。

未绑定时 `unboundReason` 是闭集恢复事实（已绑定时恒为 `null`）：`"lead_session_git_proof_failed"`（既有 Lead 会话选择的 Git proof 现在失败，如 repo 被删除——不回退到更低优先级 authority）、`"server_config_git_proof_failed"`（显式 `--workspace-root` 的 proof 失败）或 `"no_workspace_authority"`（无可用 workspace authority；mcp_root 失败折叠于此）。它只区分"哪个 authority 的证明失败"，绝不返回路径或动态错误。失败返回固定安全文案 `workspace_status failed`。

## MCP `workspace_select`（会话级工作区选择）

`workspace_select` 让 Lead 在当前 MCP 会话中选择工作 Git 项目（`lead_session` 来源，最高优先级）。**会话级**：只作用于当前 `createWaoMcpServer` 实例，两个 server 实例状态严格隔离；不写磁盘、不写 `.codex/config.toml`、不写 transcript、不创建 run/worktree/process，无需 host bind 或重启。验证委托 `proveWorkspace` SSOT——只接受 canonical Git 顶层（拒绝 relative/nonexistent/non-Git/subdirectory）。失败选择不影响既有有效选择（只在成功时更新）。幂等：重复选同一 repo 是 no-op。

输入 `workspaceRoot` 必须为非空绝对路径（≤1024 字符）；参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。失败返回固定安全文案 `workspace_select failed: workspaceRoot must be a canonical Git top-level directory`（不回显传入路径、stderr 或异常 message）。

典型 Lead 流程：`workspace_status`（未绑定）→ `workspace_select(<current Git root>)` → `workspace_status`（确认 `lead_session`）→ `run_dispatch`。

## MCP `lead_preflight`（advisory 启动检查）

`lead_preflight` 让 Lead 一次调用完成 workspace 选择/确认 + worker credential 可用性 + active-run 查询，替代机械地依次调用 `workspace_select`/`workspace_status` + `registry_list` + `runs_list`。**advisory，不是 gate**：每项检查独立结算（一项失败不吞其他），输出是事实供 Lead 判断，绝不自动中止——不产生 permit/token/approval 状态，`run_dispatch`/`workspace_select`/`registry_list`/`runs_list` 不依赖它曾成功。`complete` 仅表示机械事实（registry 可读、必需凭据 env 名存在/不存在、active run 可数）是否可读取，不是 authenticated/entitled/live-checked 的证明，也不是"是否应派发"的裁定。认证/授权证明边界见 `docs/certification-runbook.md` §认证与当前就绪。

输入 `workspaceRoot` 可选；提供时复用 `workspace_select` 的 workspace authority SSOT（`lead_session`），失败不覆盖既有有效选择；省略时只检查当前 session selection。输出是安全投影，不含绝对路径/credential value/prompt/command/PID/session。不返回 `PASS`/`FAIL`；check-level 状态为 `observed`/`warning`/`unknown`。`manualChecks` 指向原始 MCP 工具，允许 Lead 独立复核（与聚合结论不同时，Lead 可依据直接证据继续并记录 friction）。Active run、conditional worker、dirty workspace 的派发边界见 `docs/certification-runbook.md` §认证与当前就绪。

`registryIssues`/`registryIssuesTruncated` 复用与 `registry_list` 同一闭集 issue 形状与同一快照（见上文 `registry_list`）。`registryIssues` 非空时 `checkStatus.workers` 升为 `"warning"`（从而使 `complete:false`）并追加一条计数 warning，但有效 worker 照常返回——一条坏条目绝不隐藏其余 healthy worker。registry 整源不可读时 `workers` 为 `null`、`checkStatus.workers:"unknown"`、`registryIssues:[]`（unknown 绝不伪造为"零坏条目"）。

未绑定时 `workspace.unboundReason` 与 `workspace_status` 同一闭集（见上文）。

`activeRuns`/`activeRunCount` 只计**经证明 active** 的 run——transcript 为已知非终态**且**有 fresh owner heartbeat（`ownerLiveness` SSOT，默认 10s 阈值）。非终态但缺少 fresh heartbeat 的 run（如历史 stale transcript）不算 active，但也绝不据此推断它 failed/dead/stopped——它仍可能在长时间运行或休眠。这类 run 计入 `unresolvedRunCount`（与 `activeRuns` 同一次扫描，无需重新扫描），并在 `unresolvedRunCount > 0` 时追加一条 advisory observation（说明这些 run 被排除出 `activeRuns`、不证明失败或停止，请用 `runs_list` 独立查看）。`activeRunCount=0` 不应被误读为"工作区干净"。active-run 查询不可读时 `activeRuns`/`activeRunCount`/`unresolvedRunCount` 均为 `null`（unknown，绝不伪造为 0）。

## 项目级 Workspace Activation（`mcp bind`，可选）

正常使用不要求先 bind：Lead 可在当前会话用 `workspace_select` 选择 Git 项目（见上文），无需 Human Owner bind、无需项目配置、无需重启。`mcp bind` 只是**可选的持久项目级默认**，为希望冷启动即自动绑定某项目的场景提供便利——它写入的 `--workspace-root` 属 `server_config` 来源（优先级最低，见 `workspace_status`）。

`mcp bind/status/unbind` 命令是各 agent harness 接入 WAO MCP 的操作面（Human Owner 面，不是 MCP 工具）：`bind` 给出或写入注册，`status` 回答"这个 harness 上 WAO 的 MCP 注册了没有"。宿主闭集与能力由 `src/hostAdapters/hostDescriptors.js` 冻结描述符表派生，三能力轴：snippet（能产出该宿主形态的注册片段）/ autoBind（`bind` 能真写该宿主配置）/ hostVerified（已在真实宿主上验证加载）。三种能力为何分开算，见决定 0043。

- **autoBind 宿主（当前 = codex）**：`bind` 真写目标项目 `.codex/config.toml` 中的 WAO managed block（含 `--workspace-root` 绑定到项目 canonical Git root），提供持久项目级默认——但不是正常使用的前置条件。
- **snippet-only 宿主（当前 = claude-code、zcode、kimi-code、opencode、claude-desktop）**：`bind` **emit 精确注册片段而非写配置**——零写入，输出明说 `SNIPPET GENERATED — NOT BOUND`（输出片段 ≠ 绑定成功）；文件式注册的宿主另带 `configFile`（要并入片段的配置文件位置）。`status` 只读探测该宿主自己的配置，返回四态之一：`registered`（生效的 wao 条目指向本安装）/ `registered_other_target`（生效条目指向另一份 WAO 安装）/ `not_registered`（没有条目，或条目被禁用）/ `unknown`（配置读不了或解析不了——只有文件确实不存在才算"没有"，权限错误、损坏的 JSON 一律 unknown，绝不折算成未注册）。多个配置来源按**该宿主自己的覆盖语义**取生效条目——Claude Code 是高优先级整条覆盖（高优先级来源读不了时整体 unknown），opencode 是各来源按键合并（任一来源读不了即 unknown）；`sources` 按优先级从高到低列出看过的每个位置并标出 `effective`。`registered` 只说明配置里有条目，宿主要开新会话才加载。`unbind` 返回 `nothing_to_unbind`（WAO 从未写其配置）。
- **表外宿主**：`bind --host <任意名>` emit 通用 stdio 片段并明说 `GENERIC SNIPPET — NOT BOUND, FORMAT NOT VERIFIED`（command/args 是宿主中立事实，该宿主的配置语法自理）；`status` 返回 `unsupported_host` 并说明 WAO 对它没有探测；`unbind` 报错给出 known hosts 闭集。
- **`mcp status` 不带 `--host`** = 全宿主一览：逐个表内宿主给出 `registered`（true / false / null=查不了）与状态；codex 行把项目级绑定与用户级注册（`userRegistration`）合并判定。`detectedHost` 报出本次命令是否运行在某个可识别的宿主会话里。
- **派发 advisory**：`run` 派发发生在可识别的宿主会话里（按描述符表里核实过的环境标记识别），而该宿主上 WAO 的 MCP 未注册时，stderr 输出一行 `[wao] advisory: this is a <host> session and WAO's MCP is not registered there — you are on the CLI channel…`。命令行是合法通道，这一行只是告知 MCP 工具在该宿主上不可用：每个宿主会话、每个项目目录只判一次（会话键取宿主的会话变量，没有则按日；并发派发里只有一个进程出行）；已注册、识别不出宿主、配置读不了时都不出行；不阻塞派发。

各宿主的注册方式（`<argv>` 与片段以 `mcp bind --host <host>` 的输出为准；注册后用 `mcp status --host <host>` 核对）：

| 宿主 | 注册 | `status` 探测的位置 |
|---|---|---|
| claude-code | `claude mcp add wao --scope user -- <argv>` | 按 Claude Code 的优先级：当前目录的 local 级 > 项目 `.mcp.json` > user 级（前后两项在 `~/.claude.json`，随 `CLAUDE_CONFIG_DIR` 迁移） |
| codex | 项目级 `mcp bind --host codex --cwd <git-root>`；用户级 `codex mcp add wao -- <argv>` | 项目 `.codex/config.toml` 与用户级（经 `codex mcp list --json`，不解析 TOML） |
| zcode | 本地插件包（见下） | `~/.zcode/cli/config.json` 的启用标记 + 已安装插件副本（缓存里多个版本指向不一致时报 unknown） |
| kimi-code | 把片段的 `mcpServers.wao` 并入 `~/.kimi-code/mcp.json`（无注册子命令）；该宿主不提供 MCP roots，接入后先调 `workspace_select` | 同一文件 |
| opencode | 把片段的 `mcp.wao` 并入 `~/.config/opencode/opencode.json`（`opencode mcp add` 是交互式向导） | 各来源**按键合并**后的 wao 条目，覆盖顺序：`OPENCODE_CONFIG_CONTENT` 内联 > 项目根 `opencode.json(c)` > `OPENCODE_CONFIG` 指定文件 > 全局文件（合并语义按官方文档纳入，本机只核实过全局文件的形状） |
| claude-desktop | 把片段的 `mcpServers.wao` 并入 `%APPDATA%\Claude\claude_desktop_config.json`，完全退出并重启桌面端 | 同一文件 |

表内六个宿主都已完成真机加载验证；claude-desktop 只核实到握手完成、`tools/list` 有返回（对话内调用未演练，配置位置只核实过 Windows）。codex 偶发某个会话看不到工具（未归因）。zcode 的接法特殊：**zcode 片段 = 本地插件包形态**（`.claude-plugin/plugin.json` + 根级 `.mcp.json` 扁平 server 映射 + 本地名录），官方接入命令 `zcode plugins marketplace add <名录目录> && zcode plugins install wao@wao-local`，新会话加载 WAO 全部工具（前缀 `mcp__plugin_wao_wao__`；计数见生成层 docs/surface/mcp-tools.md）。`.mcp.json` 的 wao 条目携带 **`timeoutMs: 660000`**：zcode 宿主对单个工具调用的默认超时是 30000ms，会把超过 30s 的等待族调用（`run_wait` / `run_await_result` / `run_consult`）掐成假失败；660000 = 600s 最大阻塞预算 + 60s 余量。早期装机没有该字段，需重装或更新插件（或按片段手改 `.mcp.json`）。

**前置条件**（仅 autoBind/codex 路径）：项目必须是 Codex trusted project（在 Codex Desktop 打开一次即建立 trust）。详见 Codex 官方文档 `.codex/config.toml (trusted projects only)`。

**真实可执行入口**（第三方安装默认没有全局 `wao` 命令；开发仓 `npm link` 后可用全局 `wao`——安装形态与定位见 `AGENT_ONBOARDING.md`）：

```powershell
# bind: 在目标项目中生成 WAO managed block
& "D:\path\to\wao\scripts\wao-cli.cmd" mcp bind --host codex --cwd "D:\path\to\repo"

# status: 查询绑定状态
& "D:\path\to\wao\scripts\wao-cli.cmd" mcp status --host codex --cwd "D:\path\to\repo"

# unbind: 移除 WAO managed block（保留用户其它配置）
& "D:\path\to\wao\scripts\wao-cli.cmd" mcp unbind --host codex --cwd "D:\path\to\repo"
```

或在 WAO repo 内：`npm run cli -- mcp bind --host codex --cwd <git-root>`。

`.cmd` 文件不能通过 `node xxx.cmd` 调用——它必须由 PowerShell 或 cmd.exe 直接执行。

**安全契约**：

- 不修改全局 `~/.codex/config.toml`，不写入 credential value。
- 只写 `.codex/config.toml`（精确路径排除进 `.git/info/exclude`，不修改 tracked `.gitignore`）。
- 同名 `[mcp_servers.wao]` 整表替换全局的 command/args；env 从全局继承。
- tracked `.codex/config.toml` → fail-closed；既有非 WAO `[mcp_servers.wao]` → fail-closed。
- managed block 含 SHA-256 checksum，外部修改后 unbind fail-closed。

**`configured` vs `active`**：`mcp status` 返回 `configured`（配置已正确写入），不返回 `active`。真实 Codex host 加载需要 trust + 重启/新任务——只有人在独立的 Codex Desktop 会话中才能验证 `active`。
