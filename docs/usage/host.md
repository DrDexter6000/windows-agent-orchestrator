# 接入宿主与绑定项目

> [使用手册](../usage.md)的一页：把 WAO 的 MCP 服务注册进宿主（Claude Code、Codex、OpenCode），并把会话绑定到一个项目。

## MCP stdio 接口（agent-facing primary，M9）

WAO 是 MCP-first 控制面（Decision 0017）：一个 MCP host（如 Claude Desktop、Codex、OpenCode、其它 agent runtime）可通过 stdio 把 WAO 当作 MCP server 调用。工具计数、参数与形状不在本文维护：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。常用 Lead 闭环为 inventory → workspace_status/select → dispatch → await result → delivery review bundle → acceptance，另有原子 status/wait/collect/activity/diagnose、delivery query/review/reverify、stop/list recovery、Lead 授权修正续跑 run_continue。built-in playbook catalog **不在工具面**——它是按需读取的 MCP resources（`wao://playbooks`，见[取结果与查历史](results.md)）。`run_await_result` 是 advisory 只读便捷工具：一次调用等待终态（waitMs 0..270000，默认 270000；0 为 point-in-time）后返回安全 compact 终态结果 + 真实 run/liveness 观测，snapshot-only 零 audit，绝不 stop/decide/repackage；非终态时 Lead 可按任意合法 waitMs 再调，所有原子工具（run_wait/run_collect/run_status…）始终可用。`waitMs` 约束工具主动 sleep/poll 的总等待预算，而不是给每个内部阶段各分配一份预算；本地 transcript 文件读取与同步 snapshot 投影不能在 JavaScript 执行中途抢占，极端存储停顿可能让实际墙钟略超预算，工具不把这种环境延迟谎报成 worker 失败。`observationOutcome` 区分干净读取（observed）与 transcript 读失败（read_failure）；读失败时必带闭集机器码 `readFailureReason`（`transcript_parse_failed`=读取/JSON 解析异常、`legacy_event_shape`=历史非可用条目/快照形状不兼容、`snapshot_unavailable`=其他安全非解析类失败；observed 为 null），供 Lead 机器化决策——字段只含闭集码，绝不泄漏错误 message/path/command/credential，unexpected 内部异常仍保持固定 opaque 错误（M12-6 FR-08）。每个 tool 直接调用共享 application service，不 shell-out CLI。当前工具清单权威表见 `SKILL.md` 与 `docs/02-architecture.md`。

**M12-11 统一观察/终止事实**（`run_wait` 与 `run_await_result` 同形附加闭集字段，零 control/语义边界变更）：两者都附带 `observation: { outcome, waitedMs, windowMs }` 与 `termination: null | { state, source, configuredMs, policySource }`。`observation.outcome ∈ { point_in_time, window_expired, terminal, read_failure }` 让 Lead 不再猜测"窗口到期 / 终态 / 读失败"；`termination` **仅在干净观测到终态时非空**——窗口到期/读失败/transport 丢失一律 `null`，绝不折叠成 worker 已停止。`termination.source ∈ { completion, execution_deadline, manual, provider, backend, control_plane, unknown }` 是闭集终止来源（`execution_deadline` 仅当 WAO 截止定时器真触发；provider/backend/control_plane 由诊断 SSOT 投影，不含 raw error/reason/path/command/credential）。所有事实从**同一 snapshot** 派生并绑定 runId，零额外读、零 transcript 追加。`run_wait` 因此获得与 `run_await_result` 一致的 fail-closed 读失败语义（liveness/ownerHeartbeat 为 `unknown`，不拼陈旧事件 + 新鲜心跳）。Transport 恢复：若调用无返回结果，观察状态 unknown，这两个只读工具未做任何 control-plane 变更、未停 worker——point-in-time 重读 `run_await_result(waitMs:0)` 或 `run_status`，**绝不从 transport 丢失推断 worker alive/dead**。

**M12-9 三项机械增强**（均不改 control/语义边界，不新增门禁）：① `run_dispatch` 输入新增可选顶层 `executionProfileId`（与 `delivery` 同级；取自冻结可信 profile catalog，仅提供 delivery 验证的 setup/assertion 命令，与 inline `delivery.verificationCommands`/`delivery.verificationSetupCommands`/`delivery.verificationUnavailableReason` 互斥、仅 delivery 使用、派发前解析；未知/冲突由共享 resolver 稳定拒绝）；② 新增 advisory 只读工具 `run_dispatch_contract_check`（MCP adapter 在它与 `run_dispatch` 间共享输入 schema——service 自身不导入 Zod；service 复用同一 application 校验即共享 resolver + prepareDeliveryRequest，返回闭集 workspace/registry/contract 视图 + 有界 issue 码；`contractValid` 只反映 delivery/profile 机械合同，不预评 `expectedGitHead`/`expectedDirty`/`expectedWorkspaceRoot`、continuable/backend/session 资格或 worker 凭据——非门禁，sections 独立 settle 为 `observed`/`unknown`、`advisory` 恒为 `true`，零副作用，`run_dispatch` 不可依赖它，其部分失败不影响派发；R4 起它与 `run_dispatch` 共享输入 schema，故同样**接受**顶层 `readOnly` 字段但**不评估**它——只读是派发声明，不是 delivery 合同维度）；③ `run_await_result` 在终态且快照干净时附带有界闭集 `outcome`（terminalState / diagnosis(category/code/signalCount) / delivery(requested/readiness/available/failureCode/verificationStatus/verificationFailureCode/acceptanceStatus/decisionType) 安全事实；不含 commit id、changed paths、diff、command 文本、message/stderr、绝对路径或推荐，复用同一 snapshot 一次读取、零额外 transcript/Git 读、零 messages.collected 追加；非终态/read_failure → `outcome` 为 null）。**M12-13 增补**：`outcome.delivery` 追加 `isolationFailureCode`（闭集码或 null）——终端 delivery-requested run 且隔离违反为唯一较高优先级 delivery 事实时投影（见[交付与验收](delivery.md)的 `run_delivery` 一节，readiness `isolation_failed`），与 `deliveryFailure`（packaging 失败）严格分离。

**Host 注册说明**：`npm run mcp` 仅用于在 WAO repo 内手工 smoke；正式 host 注册应指向 Node shim 和 stdio entrypoint 的**绝对路径**，并为 registry 和 runDir 指定绝对路径——MCP host 的启动 cwd 不保证是 WAO repo。host 配置语法由 host 自己负责。注册后若当前会话未发现工具，重启或重载 host。Provider credential 必须由 host 通过其安全 env inheritance/allowlist 提供——不把 credential value 写入 repo、worker prompt 或 MCP args。WAO 不接管 host-global auth。

### 冻结工具面（always-registered tools，M12-10 progressive-disclosure correction + M12-16 run_correct）

WAO 的 MCP 工具**全部始终注册**（对**任何完成 MCP 接入的宿主**：接入通路闭集与各宿主能力由 `src/hostAdapters/hostDescriptors.js` 冻结描述符表承载——决定 0043 三能力轴 snippet/autoBind/hostVerified；表外宿主 fail-closed，host-neutral 片段兜底）：无 profile、无启动 flag、无 restart-to-recover——每个操作工具对连接的整个生命周期都可独立调用。这是一个**静态呈现层**：它**不是**权限层、**不是**路由层、**不按** host/runtime 名分支（Claude/Codex/Kimi/OpenCode 一视同仁，无任何 `if host==…`），也不依赖 `tools/list_changed` 或运行期动态注册。工具面的字节稳定性**分层**（ADR 0021）：`name` 与注册顺序逐字节冻结；`inputSchema`/`outputSchema`/`annotations` 由 description 剥离 SHA-256 冻结契约哈希锁定（仅限 additive 变更 + 显式重冻结记录）；`description` 可修订——受冻结字节天花板约束、每次修订附 Lead 复核记录。演进 additive-first，减面两级程序见 `.wao/decisions/0021`。参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。

原 playbook 工具已**整体移出工具面**（M12-10），built-in playbook catalog 改为按需读取的 MCP resources（`wao://playbooks`，见[取结果与查历史](results.md)）；M12-16 增 `run_correct`（queued in-flight correction）。全部工具（含 `workspace_select`、`run_dispatch_contract_check`、`run_wait`、`run_correct`）不再被任何子集隐藏，因此一个永不重启的 Host 保留全部操作能力。所有 `DRILLDOWN_TOOLS` 闭集成员（`run_status`/`run_activity`/`run_collect`/`run_delivery`/`run_delivery_review`/`run_diagnose`）均在冻结工具面内，故 `availableDrilldowns` 渐进式披露提示永远只广告可安全调用的观察工具；它只披露、不自动调用、不决策、不广告 mutation/control 工具。

单一冻结来源在 `src/mcp/toolSurface.js`（工具名单的 frozen 数组 + 唯一性/计数/无 playbook 工具的模块加载不变量）；`server.js` 在构造期对实际注册序列做 deepEqual 自检，绑定 production 到该 SSOT。

**legacy argv 兼容**：stdio argv parser 将任何残留的旧 profile 参数视为**普通未知 flag** 忽略——不解析值、不出现在解析输出、不改变 server 面、不失败启动；`--registry`/`--run-dir`/`--workspace-root` 解析与 fail-closed 语义逐字节不变。无需为既有 Host 配置做任何迁移。

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

OpenCode（`opencode-ai` npm 包，不是已废弃的 `opencode`）作为 MCP Lead host 时，**项目级配置写在目标项目根目录的 `opencode.json`（或 `opencode.jsonc`），不写在 WAO repo**。本地 MCP schema 与上面的通用 JSON 不同：`command` 是**单个字符串数组**（可执行文件 + 全部参数都在数组内）。`enabled` 是 OpenCode **optional** 配置（官方 schema 不强制）；下面示例仍**推荐显式写 `"enabled": true`** 以消除配置继承歧义，但省略不必然导致禁用（取决于 OpenCode 版本与父配置继承）。

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
- `enabled` 是 OpenCode **optional** 配置（官方 schema 不强制为必填）。示例中**推荐显式写 `"enabled": true`**，用于消除配置继承歧义、避免被父配置/全局默认覆盖；但省略不必然导致该 server 被禁用（实际行为取决于 OpenCode 版本与继承链）。
- `--workspace-root` 指向**目标项目**根，不是 WAO repo。这是 host-bound workspace binding，`run_dispatch` 会在调用 shared service 前重新证明 workspace 并以 canonical Git root 作为 server-owned `cwd`。
- 这是 host-local 配置，含绝对路径时**默认不建议 commit**；Owner 可把它放进 `.git/info/exclude`（本地忽略，不污染 `.gitignore`）。
- **验证**：在**目标项目**根执行 `opencode --pure mcp list`，期待看到 `wao connected`。`--pure` 会禁用 OpenCode 插件（如 oh-my-openagent），用于排除插件干扰；它**不**保证禁用全局 MCP 配置，也不自动移除全局 MCP。
- **重启边界**：修改配置后，**必须启动新的 OpenCode 进程**。`opencode --pure mcp list` 显示 `wao connected` 不等于已运行的旧进程工具已热加载——旧进程仍看不到 WAO tools。
- **不要无交互使用 `opencode mcp add` 配 local stdio**：该子命令对 local stdio 是交互式入口，不是稳定脚本路径。当前推荐做法是直接维护上面的项目级 JSON。

`registry_list` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入无参数——`registryPath`/`runDir` 是 server 启动配置，模型每次调用不能覆盖。输出为 MCP `content`（text = JSON）+ `structuredContent`（同义对象）。

`agents` 元素语义与 CLI `registry list --format json` 的数组元素一致（MCP 仅多一层 `agents` 包装）。`registry_list` 是只读操作，调用前后 runDir 不会有新增 transcript/run 文件。

**TD-111 certification advisory context**（`certificationReasonCode` / `certificationLastHealthyAt`）正文已完整迁移至 `docs/certification-runbook.md` §认证与当前就绪（单向链接；唯一权威）。

**M12-25 bounded partial inventory（Outcome 1）**：MCP `registry_list`（与 `lead_preflight`）走一条**独立的部分投影**路径——registry 源可读但某条目无法 normalize/project 时，**有效 worker 照常返回**，另附有界安全的逐条 `issues` 而非整表失败。`issues` 元素形状固定为 `{ "code": "invalid_id" | "invalid_configuration", "agentId": "<canonical id>" | null }`：`code` 是闭集（`invalid_id`=id 非 canonical；`invalid_configuration`=canonical id 但 backend/cwd/model/provider/sessionReuse/waitTimeout/systemPrompt 校验失败），`agentId` 仅当 id 为 canonical 时投影、否则 `null`（**绝不**回显原始 id）。**绝不**携带原始 error 文本、配置、路径或凭据值；条目数上限 32（`REGISTRY_ISSUES_CAP`），超限设 `issuesTruncated:true`（真实 malformed 数无界）。零有效 worker **但有 issues** ≠ 观察干净的空 registry（`issues` 非空）。这与严格的 registry 维护路径（CLI `registry validate` / `registry list` 仍遇首条坏条目即抛错）是**分开**的投影：WAO 不据此自动停止派发、不自动换 worker、不把坏条目标记为 healthy。整表源不可读或非法 JSON 是**另一类**失败——`registry_list` 直接返回固定 error（`lead_preflight` 则 `checkStatus.workers:"unknown"`、`workers:null`），绝不伪造成部分结果。registry 源每次 MCP 操作**只读/解析一次**；`lead_preflight` 复用同一快照结果，绝不回退二次读取。

**M11-7 凭据可用性**（`credentialAvailability`）与 **M12-6 FR-02 provider readiness 真相**（`providerReadiness` 字段含义与语义铁律：历史认证与当前凭据、授权、容量的区别）正文已完整迁移至 `docs/certification-runbook.md` §认证与当前就绪（单向链接；唯一权威）。

## MCP `workspace_status`（workspace binding 状态查询，M10-pre2 + M11-6）

`workspace_status` 查询当前 workspace 绑定状态。`run_dispatch` 在执行前**自行重新证明** workspace，不信任此工具的先前结果。

`workspace_status` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入是 strict empty schema（拒绝任何字段）。

`source` 的三个取值对应三种 workspace authority：`"lead_session"`（Lead 会话选择）、`"mcp_root"`（client roots/list）、`"server_config"`（显式 `--workspace-root`）。`workspaceRoot` 是当前绑定的 canonical Git 顶层绝对路径（Lead/host 已显式提交，非 credential，故返回）；`bound=false` 时其余字段均为 `null`。

**M12-19 unboundReason（recovery truth，闭集）**：未绑定时 `unboundReason` 是闭集恢复事实（恒为 `null`，当已绑定）：`"lead_session_git_proof_failed"`（既有 Lead 会话选择的 Git proof 现在失败，如 repo 被删除——**不**回退到更低优先级 authority）、`"server_config_git_proof_failed"`（显式 `--workspace-root` 的 proof 失败）或 `"no_workspace_authority"`（无可用 workspace authority；mcp_root 失败折叠于此）。只区分"哪个 authority 的证明失败"，**绝不**返回路径或动态错误。失败返回固定安全文案 `workspace_status failed`。

## MCP `workspace_select`（Lead 会话级工作区选择，M11-6）

`workspace_select` 让 Lead 在当前 MCP 会话中选择工作 Git 项目（`lead_session` 来源，最高优先级）。**会话级**：只作用于当前 `createWaoMcpServer` 实例，两个 server 实例状态严格隔离；不写磁盘、不写 `.codex/config.toml`、不写 transcript、不创建 run/worktree/process，无需 host bind 或重启。验证委托 `proveWorkspace` SSOT——只接受 canonical Git 顶层（拒绝 relative/nonexistent/non-Git/subdirectory）。**失败选择不影响既有有效选择**（只在成功时更新）。幂等：重复选同一 repo 是 no-op。

`workspace_select` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入 `workspaceRoot` 必须为非空绝对路径（≤1024 字符）。

失败返回固定安全文案 `workspace_select failed: workspaceRoot must be a canonical Git top-level directory`（不回显传入路径、stderr 或异常 message）。

典型 Lead 流程：`workspace_status`（未绑定）→ `workspace_select(<current Git root>)` → `workspace_status`（确认 `lead_session`）→ `run_dispatch`。

## MCP `lead_preflight`（advisory 单调用启动检查，M11-8A）

`lead_preflight` 让 Lead 一次调用完成 workspace 选择/确认 + worker credential 可用性 + active-run 查询，替代机械地依次调用 `workspace_select`/`workspace_status` + `registry_list` + `runs_list`。**ADVISORY ONLY，不是 gate**：每项检查独立结算（一项失败不吞其他），输出是事实供 Lead 判断，绝不自动中止——不产生 permit/token/approval 状态，`run_dispatch`/`workspace_select`/`registry_list`/`runs_list` 不依赖它曾成功。`complete` 仅表示机械事实（registry 可读、必需凭据 env 名存在/不存在、active run 可数）是否可读取，**不是** authenticated/entitled/live-checked 的证明，也不是"是否应派发"的裁定 认证/授权证明边界（M12-6 FR-02：preflight 完成永不意味着任何 worker 已被认证/授权/做过 live check）见 `docs/certification-runbook.md` §认证与当前就绪（单向链接；唯一权威）。

`lead_preflight` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入 `workspaceRoot` 可选；提供时复用 `workspace_select` 的 workspace authority SSOT（`lead_session`），失败不覆盖既有有效选择。省略时只检查当前 session selection。输出是安全投影，不含绝对路径/credential value/prompt/command/PID/session。

不返回 `PASS`/`FAIL`；check-level 状态为 `observed`/`warning`/`unknown`。`manualChecks` 指向原始 MCP 工具，允许 Lead 独立复核（与聚合结论不同时，Lead 可依据直接证据继续并记录 friction）。Active run、conditional worker、dirty workspace 的派发边界见 `docs/certification-runbook.md` §认证与当前就绪（单向链接）。

**M12-25 registry partial truth**：`registryIssues`/`registryIssuesTruncated` 复用与 `registry_list` 同一闭集 issue 形状与同一快照（见上文 §`registry_list` 的 M12-25 段）。`registryIssues` 非空时 `checkStatus.workers` 升为 `"warning"`（从而使 `complete:false`）并追加一条计数 warning，但**有效 worker 照常返回**——一条坏条目绝不隐藏其余 healthy worker；Lead 可据 `registry_list` 查看有界逐条 issue。registry 整源不可读时 `workers` 为 `null`、`checkStatus.workers:"unknown"`、`registryIssues:[]`（unknown 绝不伪造为"零坏条目"）。

**M12-19 recovery truth**：未绑定时 `workspace.unboundReason` 与 `workspace_status` 同一闭集（`lead_session_git_proof_failed` / `server_config_git_proof_failed` / `no_workspace_authority`，已绑定恒为 `null`）——让 Lead 在单次 preflight 内直接看到"哪个 authority 的证明失败"，绝不返回路径或动态错误。

**M12-15 stale active-run truth**：`activeRuns`/`activeRunCount` 只计**经证明 active** 的 run——即 transcript 为已知非终态**且**有 fresh owner heartbeat（`ownerLiveness` SSOT，默认 10s 阈值）。一个非终态但缺少 fresh heartbeat 的 run（例如历史 6 月的 stale transcript）**不算** active，但也**绝不**据此推断它 failed/dead/stopped——它仍可能在长时间运行/休眠。这类 run 计入 `unresolvedRunCount`（与 `activeRuns` 同一次扫描/快照，Lead 无需重新扫描），并在 `unresolvedRunCount > 0` 时追加一条 advisory observation（说明这些 run 被排除出 `activeRuns`、不证明失败或停止，请用 `runs_list` 独立查看）。因此 `activeRunCount=0` 永远不应被误读为"工作区干净"——当 `unresolvedRunCount > 0` 时尤其如此。active-run 查询不可读时 `activeRuns`/`activeRunCount`/`unresolvedRunCount` 均为 `null`（unknown，绝不伪造为 0）。

## 项目级 Workspace Activation（M10 P0-1，**可选** Human Owner ops 命令）

> **M11-6 起，正常使用不要求先 bind。** Lead 可在当前会话用 `workspace_select` 选择 Git 项目（见上文 §`workspace_select`），无需 Human Owner bind、无需项目配置、无需重启。`mcp bind` 只是**可选的持久项目级默认**——为希望冷启动即自动绑定某项目的场景提供便利。

MCP workspace binding 来源优先级：`lead_session`（`workspace_select`）> `mcp_root`（client roots/list）> `server_config`（显式 `--workspace-root`）> fail-closed。`--workspace-root` 是全局静态启动参数。

`mcp bind/status/unbind` 命令是各 agent harness 接入 WAO MCP 的操作面（Human Owner 面，不是 MCP 工具）：`bind` 给出或写入注册，`status` 回答"这个 harness 上 WAO 的 MCP 注册了没有"。宿主闭集与能力由 `src/hostAdapters/hostDescriptors.js` 冻结描述符表派生（决定 0043，三能力轴：snippet / autoBind / hostVerified；决定 0066 增补注册状态只读探测、表外宿主通用片段与派发 advisory）：

- **autoBind 宿主（当前 = codex）**：`bind` 真写目标项目 `.codex/config.toml` 中的 WAO managed block（含 `--workspace-root` 绑定到项目 canonical Git root），提供持久项目级默认——但不是正常使用的前置条件。
- **snippet-only 宿主（当前 = claude-code、zcode、kimi-code、opencode、claude-desktop）**：`bind` **emit 精确注册片段而非写配置**——零写入，输出明说 `SNIPPET GENERATED — NOT BOUND`（输出片段 ≠ 绑定成功）；文件式注册的宿主另带 `configFile`（要并入片段的配置文件位置）。`status` **只读探测该宿主自己的配置**（决定 0066，取代原 `not_applicable`），返回四态之一：`registered`（生效的 wao 条目指向本安装）/ `registered_other_target`（生效条目指向另一份 WAO 安装）/ `not_registered`（没有条目，或条目被禁用）/ `unknown`（配置读不了或解析不了——只有文件确实不存在才算"没有"，权限错误、损坏的 JSON 一律 unknown，绝不折算成未注册）。多个配置来源按**该宿主自己的覆盖语义**取生效条目——Claude Code 是高优先级整条覆盖（高优先级来源读不了时整体 unknown），opencode 是各来源按键合并（任一来源读不了即 unknown）；`sources` 按优先级从高到低列出看过的每个位置并标出 `effective`。`registered` 只说明配置里有条目，宿主要开新会话才加载。`unbind` 返回 `nothing_to_unbind`（WAO 从未写其配置）。claude-code 片段 = mcpServers JSON + 一行命令；**zcode 片段 = 本地插件包形态**（`.claude-plugin/plugin.json` + 根级 `.mcp.json` 扁平 server 映射 + 本地名录），官方接入命令 `zcode plugins marketplace add <名录目录> && zcode plugins install wao@wao-local`——2026-10-03 真机验证：新会话加载 WAO 全部工具（前缀 `mcp__plugin_wao_wao__`；计数见生成层 docs/surface/mcp-tools.md）。`.mcp.json` 的 wao 条目携带 **`timeoutMs: 660000`**：zcode 宿主对单个工具调用的默认超时是 30000ms，会把 >30s 的等待族调用（run_wait / run_await_result / run_consult）掐成假失败（2026-10-04 跨项目会话实测）；600s 最大阻塞预算 + 60s 余量，透传与执行均已实证（3000ms 负探针掐断 + 660000 下 50.6s 阻塞正常返回）。旧装机需重装/更新插件（或按片段手改 `.mcp.json`）才得到该字段。
- **表外宿主**（决定 0066）：`bind --host <任意名>` emit 通用 stdio 片段并明说 `GENERIC SNIPPET — NOT BOUND, FORMAT NOT VERIFIED`（command/args 是宿主中立事实，该宿主的配置语法自理）；`status` 返回 `unsupported_host` 并说明 WAO 对它没有探测；`unbind` 报错给出 known hosts 闭集。
- **`mcp status` 不带 `--host`** = 全宿主一览：逐个表内宿主给出 `registered`（true / false / null=查不了）与状态；codex 行把项目级绑定与用户级注册（`userRegistration`）合并判定。`detectedHost` 报出本次命令是否运行在某个可识别的宿主会话里。
- **派发 advisory**（决定 0066）：`run` 派发发生在可识别的宿主会话里（按描述符表里真机核实过的环境标记识别），而该宿主上 WAO 的 MCP 未注册时，stderr 输出一行 `[wao] advisory: this is a <host> session and WAO's MCP is not registered there — you are on the CLI channel…`。命令行是合法通道，这一行只是告知 MCP 工具在该宿主上不可用：**每个宿主会话、每个项目目录只判一次**（会话键取宿主的会话变量，没有则按日；并发派发里只有一个进程出行），已注册、识别不出宿主、配置读不了时都不出行；不阻塞派发。

各宿主的注册方式（`<argv>` 与片段以 `mcp bind --host <host>` 的输出为准；注册后用 `mcp status --host <host>` 核对）：

| 宿主 | 注册 | `status` 探测的位置 | 真机加载验证 |
|---|---|---|---|
| claude-code | `claude mcp add wao --scope user -- <argv>` | 按 Claude Code 的优先级：当前目录的 local 级 > 项目 `.mcp.json` > user 级（前后两项在 `~/.claude.json`，随 `CLAUDE_CONFIG_DIR` 迁移） | 2026-10-12：中立仓库无头会话加载全部工具并调用成功 |
| codex | 项目级 `mcp bind --host codex --cwd <git-root>`；用户级 `codex mcp add wao -- <argv>` | 项目 `.codex/config.toml` 与用户级（经 `codex mcp list --json`，不解析 TOML） | 2026-10-12：`codex exec` 调用 `workspace_status` 成功（三次里有一次会话未见工具，见 TD-191） |
| zcode | 本地插件包（见下） | `~/.zcode/cli/config.json` 的启用标记 + 已安装插件副本（缓存里多个版本指向不一致时报 unknown） | 2026-10-03 新会话；2026-10-12 宿主日志在场 |
| kimi-code | 把片段的 `mcpServers.wao` 并入 `~/.kimi-code/mcp.json`（无注册子命令） | 同一文件 | 2026-10-12：无头会话加载全部工具（该宿主不提供 MCP roots，需 `workspace_select`） |
| opencode | 把片段的 `mcp.wao` 并入 `~/.config/opencode/opencode.json`（`opencode mcp add` 是交互式向导） | 各来源**按键合并**后的 wao 条目，覆盖顺序：`OPENCODE_CONFIG_CONTENT` 内联 > 项目根 `opencode.json(c)` > `OPENCODE_CONFIG` 指定文件 > 全局文件（合并语义与前三项来源按官方文档纳入，本机只核实过全局文件的形状） | 2026-10-12：`opencode mcp list` connected + 无头会话调用成功 |
| claude-desktop | 把片段的 `mcpServers.wao` 并入 `%APPDATA%\Claude\claude_desktop_config.json`，完全退出并重启桌面端 | 同一文件（仅 Windows 位置核实过） | 2026-10-12：重启后宿主日志记录握手完成、`tools/list` 收到返回（对话内调用未演练） |

**前置条件**（仅 autoBind/codex 路径）：项目必须是 Codex trusted project（在 Codex Desktop 打开一次即建立 trust）。详见 Codex 官方文档 `.codex/config.toml (trusted projects only)`。

**真实可执行入口**（第三方安装默认没有全局 `wao` 命令；开发仓 `npm link` 后可用全局 `wao`——安装形态与定位见 `AGENT_ONBOARDING.md`）：

```powershell
# bind: 在目标项目中生成 WAO managed block
& "D:\projects\windows-agent-orchestrator\scripts\wao-cli.cmd" mcp bind --host codex --cwd "D:\path\to\repo"

# status: 查询绑定状态
& "D:\projects\windows-agent-orchestrator\scripts\wao-cli.cmd" mcp status --host codex --cwd "D:\path\to\repo"

# unbind: 移除 WAO managed block（保留用户其它配置）
& "D:\projects\windows-agent-orchestrator\scripts\wao-cli.cmd" mcp unbind --host codex --cwd "D:\path\to\repo"
```

或在 WAO repo 内：`npm run cli -- mcp bind --host codex --cwd <git-root>`。

注意：`.cmd` 文件不能通过 `node xxx.cmd` 调用——它必须由 PowerShell 或 cmd.exe 直接执行。

**安全契约**：
- 不修改全局 `~/.codex/config.toml`，不写入 credential value。
- 只写 `.codex/config.toml`（精确路径排除进 `.git/info/exclude`，不修改 tracked `.gitignore`）。
- 同名 `[mcp_servers.wao]` 整表替换全局的 command/args；env 从全局继承（探针验证）。
- tracked `.codex/config.toml` → fail-closed；既有非 WAO `[mcp_servers.wao]` → fail-closed。
- managed block 含 SHA-256 checksum，外部修改后 unbind fail-closed。

**`configured` vs `active`**：`mcp status` 返回 `configured`（配置已正确写入），不返回 `active`。真实 Codex host 加载需要 trust + 重启/新任务——只有 CTO 在独立 Codex Desktop 会话中才能验证 `active`。
