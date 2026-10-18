# 车道配置与维护

> [使用手册](../usage.md)的一页：配置一条车道（registry 字段、kimi 与 deepseek 车道的前提），维护 kimi 车道的 serve，找到认证入口。

## registry 配置详解

每种 backend 需要的字段不同。完整角色矩阵以 `config/agents.example.json` + `docs/team-roles.md` 为权威，本页不复制维护。下面只保留最小形状示例：

```jsonc
{
  "agents": {
    // ── opencode-serve（HTTP 类，fallback lane）──
    "coder_opencode_fallback": {
      "backend": "opencode-serve",
      "serveUrl": "http://127.0.0.1:4297",  // opencode serve 地址
      "agent": "build",                       // opencode agent 名
      "cwd": "D:/projects/my-app",            // 工作目录
      "model": { "providerID": "zhipuai-coding-plan", "id": "glm-5.2" },
      "tokenBudget": 5000000
    },

    // ── claude-code（官方 OAuth 订阅）──
    "opus": {
      "backend": "claude-code",
      "model": { "id": "<modelId>" },
      "reasoning": { "effort": "high" },
      "cwd": ".",
      "args": ["--dangerously-skip-permissions"]
    },

    // ── zcode（原厂 harness 驱动原厂 LLM）──
    "glm-flash": {
      "backend": "zcode",
      "binary": "C:/Users/<you>/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs",
      "model": { "id": "bigmodel-api/<modelId>" },
      "reasoning": { "effort": "max" },
      "cwd": "."
    },

    // ── deepseek-harness（暂停使用，为什么见决定 0074；不要从 GUI preset/TUI 抓输出）──
    "coder_dsh_experimental": {
      "backend": "deepseek-harness",
      "binary": "C:/path/to/dsh-jsonrpc-agent.cmd",
      "dshConfigPath": "C:/path/to/wao-coder.cordis.yml",
      "credentialEnv": "DEEPSEEK_API_KEY",
      "dshProvider": "deepseek-official",
      "model": { "id": "deepseek-v4-flash", "contextWindow": 1000000 },
      "reasoning": { "effort": "max" },
      "cwd": "D:/projects/my-app"
    },

    // ── deepseek-acp（shipped ACP profile + 操作员安装的 containment）──
    "coder_dsh_acp": {
      "backend": "deepseek-acp",
      "binary": "C:/path/to/dsh.cmd",        // 可选，缺省 PATH 上的 dsh
      "credentialEnv": "DEEPSEEK_API_KEY",
      "model": { "id": "<modelId>", "providerID": "deepseek-official" },  // 可选；配则 id 与 providerID 都必填
      "reasoning": { "effort": "low" },      // 可选，仅 low/high/max（见生成层 docs/surface/certification.md 能力表；其余值被拒）
      "cwd": "D:/projects/my-app"
      // 不配 provider 块：组合面固定，配了被拒。model 块只接受 { id, providerID }
      // 两个子字段，其他子字段（variant/contextWindow 等）配了同样被拒。不配
      // model 时模型取 profile 缺省。
    },

    // ── codex（进程式；codex 车道只用做会审，见车道画像）──
    "sol": {
      "backend": "codex",
      "cwd": "D:/projects/my-app"
    },

    // ── 带 worktree 隔离的 agent ──
    "glm-pro": {
      "backend": "claude-code",
      "cwd": "D:/projects/my-app",
      "args": ["--dangerously-skip-permissions"],
      "isolation": { "type": "worktree", "strategy": "persistent" }
      // strategy: "persistent"（默认，run 后保留 worktree）| "ephemeral"（run 后清理）
    }
  }
}
```

示例里的 `<modelId>` 是占位：各车道当前型号见 `config/agents.example.json` 与 `npm run cli -- wao lanes`（车道当前型号只写在配置里）。

席位角色（`seatRole` 字段）已退役，不要再声明。对抗性是派生事实：登记会审席位时，按审者车道与被审产出作者车道的关系（车道指纹比对）判定。登记命令 `npm run cli -- wao stage 2/4 --task <T> --panel-seats <a,b> [--reviewed-run <runId>[,<runId>]]`（panel 字段只在 stage 2 与 4 登记），登记时按当时的 registry 车道配置 × 被审 run 的 `run.started` 钉住作者事实：车道不同 = 对抗前提成立；席位与作者同车道 = 回避违反，大声提示（advisory，不阻断）。`--reviewed-run` 支持多值（共同作者）。作者不可读或缺 `run.started` 时如实输出 unknown，不折叠成"无违反"。老 registry 里遗留的 seatRole 字段不会被拒载：归一化直接忽略（读取面零消费），`registry validate` 对在场字段出弃用 advisory，可以删掉。

车道画像、认证简表与就绪探测一屏见 `npm run cli -- wao lanes`（只读参考面）；`lead_preflight` 带一份紧凑表：已评的格、成本、全部注意事项、暂停说明、上下文窗口与能否看图，开工时一次看全；证据与样本出处仍看 `wao lanes`。用非默认 `--registry` 时必须与 `--lanes-file` 成对给出（防跨绑，规则同 run 命令）。

车道表（`config/lanes.json`）每条车道可选带 `dispatchHold`：Owner 的暂停派发原话（去首尾空白后非空、≤200 字符、不含控制字符或行分隔符；不合法整表拒载）。WAO 只告知、不拦截——它进 `wao lanes`、`registry list` / `registry_list` 的条目与派发 stderr 提示；派不派由 Lead 决定。CLI 调用给了非默认 `--registry` 时车道表停用（防跨绑，规则同 run 命令）：`registry list` 的 `dispatchHold` 为 null，派发与会审不提示。它不是接线轴，不参与派发解析的任何裁定。

声明了 `kimiHome` 的 kimi-web 车道，凭据是 `<kimiHome>/server.token` 文件（serve 拉起时生成，见下文「kimi 车道的 worker serve」一节）；这个文件是否就绪在三处可见：

- MCP `registry_list` 的 `credentialAvailability` 按它取值：在且非空 = `available`，缺失或为空 = `missing`（输出不携带文件路径；没有环境变量参与，`missingCredentialEnvNames` 恒为空表）。
- `wao lanes` 的就绪轴按它推导（不再探 `tokenEnv`——那个变量不会被读到）：文件在且非空 = `key_only_present`，缺失或为空 = `key_only_missing`，行内点名文件路径。
- `wao doctor` 对缺失或为空的文件报 FAIL（派发必失败），提示里写文件路径与生成方式。

没有声明 `kimiHome` 的 kimi-web 车道不受影响，仍按 `tokenEnv` 探测环境变量。

deepseek-harness / deepseek-acp 通道的适用限制、`registry validate` 能力交叉 `⚠` 警告与 metrics 判读见 `docs/certification-runbook.md` §DSH 通道适用限制与能力交叉警告（唯一权威）。

## 认证正文总落点（certification runbook）

认证操作正文都在 `docs/certification-runbook.md`（唯一权威），本页不重复，只留入口。它包含：

- 认证结果用于派发选择的边界
- DSH 通道适用限制与能力交叉警告
- backend 能力对照表（权威投影是生成层 `docs/surface/certification.md`，由 `npm run gen:certification` 再生成，禁止手改）
- 认证与转录维护命令（smoke / reliability / prune）
- 单次派发换模型 / 换推理力度（含 MCP 覆盖特有规则）
- retry 的 per-dispatch 覆盖继承
- 认证与当前就绪（历史认证 ≠ 当前凭据/授权/容量）

## 接入新模型 / 新运行时

见 `docs/certification-runbook.md` §接入新模型 / 新运行时（lane 内操作 vs Owner 决策）。

## 上游 harness 原语对照

见 `docs/certification-runbook.md` §上游 harness 原语对照（实测）（含基线日与刷新期限）。

## delta 认证规程

见 `docs/certification-runbook.md` §delta 认证规程。

## 认证检查结果五态与能力轴分层

见 `docs/certification-runbook.md` §认证检查结果五态与能力轴分层。

## deepseek 车道的目录权限前提

> **deepseek 车道的目录权限前提（deepseek lane prerequisites）**：DeepSeek Harness 缺省给命令套一层 Windows 沙箱（`workspace-write`），它要求工作目录**由当前用户拥有并且有完全控制**。只有"修改"权限的目录上（非系统盘的项目目录常见），沙箱内的命令在执行之前就以 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)` 失败。两种做法，WAO 都不替你选：
>
> 1. **按车道声明权限模式（一次设好，所有项目通用）**：在 registry 的车道条目里写 `"env": { "DSH_PERMISSION_MODE": "danger-full-access" }`（取值只能是 `read-only` / `workspace-write` / `danger-full-access`，拼错即拒）。此后少了两样：harness 的写入沙箱（命令可以写到工作目录之外）和审批请求。WAO 的工作树隔离与交付范围审计还在，但它们是事后检测，拦不住 shell 的副作用。
> 2. **保留沙箱、修目录权限**：由操作者对每个项目目录执行 harness 自带的修复脚本。它会改权限：给目录链上缺权限的目录补上当前用户的完全控制项，并扫描项目目录的子树、**移除其中应用包（AppContainer）的显式允许项**（那些应用会失去对这些对象的访问）；文件内容与所有者不变，每处改动先备份并打印恢复命令。`pwsh -NoProfile -File "<npm 全局目录>\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\assets\diagnose-windows-sandbox-acl\scripts\diagnose-windows-sandbox-acl.ps1" -Path "<项目目录>" -AllowRoot "<项目目录>" -Out "<存放恢复文件的目录>"`；不要用管理员身份运行。结果以末尾的 `nextAction` 为准：`verify_original_confined_operation` 才算修好，`stop` / `restore_pending_then_stop` 就停下按它打印的恢复命令处理。

## kimi 车道的 worker serve

### 拉起 worker serve

kimi 车道指向独立 serve：

```powershell
pwsh -File scripts/kimi-serve.ps1 -KimiHome <主目录> -Port 58628 -WorkspaceDir <工作区>
```

- 主目录 = 车道的 `kimiHome`，缺省 `~/.kimi-code`。
- 工作区 = 稳定目录 `D:\projects\.kimi-serve-worker-ws`。不要用可删的临时目录。
- serve 的环境剔除规则（WAO 拉起与手动脚本同一套）：密钥类、`WAO_*`（不分大小写）、Lead 宿主的会话变量（`CLAUDE*` / `ANTHROPIC*`，不分大小写）不进 serve 环境；`KIMI_CODE_HOME` 与 `WAO_IN_WORKER=1` 显式注入。serve 会把 env 传给它的 MCP 子进程与工具 shell，因此 worker 自助派发被拒：席位内 run_dispatch 被拒且报 `Detected worker context: env-marker`；工具 shell 里 `WAO_IN_WORKER` 非空。
- Owner 人类用主 serve（默认端口 58627，不带 `WAO_IN_WORKER` 标记）。
- 车道写了 `serveWorkspaceDir` 时，派发发现 serve 没在跑会自动拉起；没写就手动拉起。
- WAO 拉起的 serve（按需拉起与 `serve recycle` 重启）空闲一段时间后由看护进程优雅关停，下一次派发会重新拉起；派发的第一条 system 说明写着看护的 pid，`serve recycle` 的结果带 `idleWatch`。判定与边界见 `docs/02-architecture.md` §2.7。手动脚本拉起的 serve 没有看护，一直运行到有人关掉；要让 serve 常驻就用脚本拉起。

### KIMI_WEB_TOKEN

- 是什么、从哪来：`kimi web` serve 的持久 Bearer token，由上游 serve 签发，**持久化在 `<kimi 主目录>/server.token`**。文件内的值就是活体凭据（用它调 `/api/v1/meta` 得 200 可验证），跨启动与优雅 shutdown 均不变。headless 获取配方就是读这个文件：重定向或无 TTY 的启动**不打印** token，上游 `--help` 里的 "printed at startup" 只适用于交互式控制台启动。
- `rotate-token` 子命令生成新持久 token，旧 token **立即失效**。token 按主目录隔离（`KIMI_CODE_HOME` 分家后两家互不相通）；轮换影响同一主目录内的全部 serve，轮换前先想清楚。
- 怎么注入：Windows User 作用域（`setx KIMI_WEB_TOKEN <值>`）。WAO 派发链读 env 有 HKCU 回退，**不需要新开终端**；需要新终端（或用 `[Environment]::GetEnvironmentVariable(...,'User')` 读取）的只有直接读进程 env 的工具（如身份探针）。值不回显；registry 只声明名（`tokenEnv: "KIMI_WEB_TOKEN"`）。Git Bash 下的引号纪律见 `docs/certification-runbook.md` 代跑取证段。
- WAO 的边界：WAO 从 registry 的 `tokenEnv` 指定的环境变量读取 Bearer 凭据，不负责令牌发放。声明了 `kimiHome` 的车道不读它，直接读主目录的 `server.token`。

### 进程荚与维护命令

serve 为每个会话在创建时拉起 6-8 个助手进程（datasource/analyzer/officecli/mcp.json 条目）且**永不拆除**：没有空闲 GC，会话或工作区删除都不触发，上游也没有停荚端点。唯一的全量拆除原语是优雅 `POST /api/v1/shutdown`。治理分三层：

1. **终态会话卫生（自动）**：kimi-web run 以 completed 收口后，WAO 自动调 serve 的会话删除 API（门 = routing 缺席 + completed-only + 删前 busy 预探针；失败仅记事件，不影响 run 结果）。failed/aborted 的会话**故意保留**，作为迟到收取的取证源。delivery 被 accept 时，线系会话同样自动释放。转录事件族：`run.upstream_session_deleted` / `_already_gone` / `_delete_skipped` / `_delete_failed`。这只治会话仓/events 文件堆积，**不拆进程**。

2. **手动维护命令**（`npm run cli -- serve …`，或全局 shim `wao serve …`）：

   ```powershell
   npm run cli -- serve status                    # 实例元数据/荚规模/会话计数
   npm run cli -- serve sweep                     # 清扫规划（默认 dry-run）
   npm run cli -- serve sweep --apply             # 删"worktree 已亡"的 WAO 认领会话
   npm run cli -- serve recycle --workspace-dir D:\projects\.kimi-serve-worker-ws
   ```

   - `sweep` 按 WAO 转录的 `session.created` 认领（扫全部项目桶），只删"worktree 已亡"（形状 + 干净 ENOENT + 父目录在场三条件）的会话；台账在 `.wao/runs/serve-maintenance/sweep-ledger.jsonl`。跨 serve 生效（kimi 会话仓实例间共享）：58627 上由 WAO 历史派发产生的会话同样会被认领。
   - `recycle` 双门（WAO 全项目桶无 active run + serve 会话集合 soak 比对全 idle）→ 优雅 shutdown 全量拆荚 → 按上面的配方重启（env 由命令组装，`WAO_IN_WORKER=1` 恒注入）→ 就绪验证 → 端口核对。`--workspace-dir` 缺省取目标车道声明的 `serveWorkspaceDir`，车道没声明才要求显式给出。重启的子进程被挤到别的端口（目标端口被占、kimi 改绑下一个端口）时会被请优雅退出，结果带 `displaced` 指明去向、`ready: false`、退出码非零。就绪后的新 serve 由上面的空闲看护接管。只动 kimi 车道 serveUrl 指向的 worker 实例；Owner 主 serve（58627）名下的存量荚由 Owner 自行重启解决。
   - serve 已死（双面连接拒绝 × 两探 + 实例 pid 已死）时，recycle 跳过杀步直接重启（`revived: true`）；pid 活着但端口拒绝 = 可能正在启动，拒绝执行（`serve_not_listening_pid_alive`）。
   - exe 在一切副作用之前解析：显式 `--kimi-exe` 缺席即拒，缺省链 kimiHome/bin → PATH → `%USERPROFILE%\.kimi-code\bin`。重启失败或未就绪时退出码非零并附手动配方指路；shutdown 后 kimi 自清实例文件，重跑 recycle 会 `no_instance` 拒绝，须按配方手动拉起。
   - 时机：跑批间隙手动调用即可。忘了的后果是荚多攒几天（有界烦恼）；上游提供 idle 荚 GC 或 :delete 连带拆荚后，recycle 退役。

3. **会话隔离与树的回收**：readOnly 非复用 run 的强制隔离是 ephemeral——终态且停止验证确认后自动回收树，未确认的留树保迟到收取；delivery 验收后线系树按四道门释放（这条路径不删分支 `wao/<runId>`，分支的清退见[维护](maintenance.md)）。树内容与 git 元数据在终态清理时即删，但**空目录壳**可能被泄漏荚的工具壳占住句柄（Windows EPERM）——`serve recycle` 杀荚后自动清扫（输出 `emptyWorktreeHusksSwept`）。sweep 探针含 busy/main_turn_active 双字段，apply 逐项复探。存量会话可走 v2 `sessions:archive` 批量归档：归档态转录仍可读、restore 可逆，台账 `.wao/runs/serve-maintenance/archive-ledger.jsonl`。

### 私有主目录（根治助手进程堆积）

助手进程是主目录里的插件与 `mcp.json` 拉起的。不装它们的私有主目录（`KIMI_CODE_HOME`）下，serve 不拉任何助手进程——这是根治办法（为什么见决定 0074）。

车道条目写 `"kimiHome": "<私有主目录绝对路径>"` 即指向它：

- token 取自 `<kimiHome>/server.token`（不读环境变量）。
- `serve status|sweep|recycle` 以它为缺省主目录。
- 换主目录要换端口（清扫按 `serveUrl` 分家）；旧主目录的会话不会跟过来。

私有主目录要先单独登录一次（`kimi login`，勿复制 credentials），并用上面的脚本拉起一次（生成 `server.token`）。此后 serve 没在跑时由派发自动拉起（车道写了 `serveWorkspaceDir` 的话），否则手动拉起。

## 认证清单门禁（MCP 边界，默认关）

MCP 边界的 `run_dispatch` 可选升级为"只派认证清单成员"（Owner 指令"派发任务永远派发认证清单中的"的机器化）：

- 开：`setx WAO_MCP_REQUIRE_CERTIFIED 1` 后**重启宿主**（环境变量在 MCP 服务进程 spawn 时定格，模型不可经 tool args 翻转或绕过）；回退：删除该变量 + 重启宿主。
- 成员资格：`selectCertRecord` 双空间命中（席位键直查 → 车道指纹扫描）且 status ∈ {certified, conditional}——例外条款族的 conditional 是常态；新鲜度不进门（30 天跑步机是展示事实，不是拒绝理由）。
- 边界：门禁只驻 MCP 边界（模型可达面）。CLI 保持 Owner/Lead 特权通道——认证 drill 本身经 CLI 自举（`npm run reliability -- --agent <lane>`），全局门 = 自举悖论。
- fail-closed：台账缺失、不可读或键空间不对 = 拒绝（固定文案含纠正路径）。
- 门关着时，认证结果按 advisory 语义使用，不因此拒绝派发。
- 翻转前建议全量刷绿一轮：新车道先认证再开门。

## opencode serve 端口不对

smoke 脚本自动探测 4297-4299。手动指定时改 `config/agents.json` 里的 `serveUrl`。
