# 部署与使用指南

> 本文档基于 M0–M10 + fresh-runtime hardening 后的实际能力编写。
> WAO 当前可用于主控监督下的正式试运行；daemon / background 派发 / resume-on-start 已落地，最终验收仍由 Lead 负责。

---

## 一、部署

### 前置要求

| 依赖 | 版本 | 检查命令 |
|------|------|---------|
| Node.js | **v22（硬约束，v24 会被拒绝，见下）** | `node --version` |
| git | 任意（worktree 隔离需要） | `git --version` |

#### Node 为什么必须 v22（不能 v24）

WAO 进程式 backend（claude-code/codex/kimi-code）的"进程死即会话死"隔离，依赖 **Node 自 v18+ 内置的 Windows Job Object**（父进程退出→OS 自动杀全部子进程树）。**Node v24 有 libuv Job Object 回归**（会误杀长进程），所以 WAO 在 cli / daemon / background-runner 入口**硬拒绝 v24**并指引切 v22。详见 TD-40 + `.wao/decisions/0013`。

- v24 上启动会看到：`WAO 拒绝启动：Node v24.x 被拒绝：v24 has a libuv Windows Job Object regression ... 请用 v22`，exit 1。
- `npm test` 同样走 v22 shim：入口为 `node scripts/wao-node.cjs scripts/canonical-test.mjs`，canonical runner 读 `test/manifest.json` 把每个 `.test.js` 恰好归入一个资源类别（pure/git/worktree/process/lock/timeout，用于归属与漂移检测），执行组织成串行波（wave）：同一波池化多个类别共享有界并发、长极重叠（filesystem 波池化 git+worktree，lock 波严格串行），并对首轮失败隔离复核一次（只追加 stable_fail/isolation_pass/environment_invalid 分类，绝不把复核通过洗成 PASS）。测试本身 mock 子进程、不依赖真实进程隔离；子进程注入 `WAO_SKIP_VERSION_GUARD=1` 绕过版本守卫。

#### 如何装 / 切到 v22

仓库根 `.nvmrc` 声明 `22`。任选一种版本管理器（推荐 nvm-windows 或 fnm）：

```powershell
# 方式 A：nvm-windows（winget 装）
winget install CoreyButler.NVMforWindows
nvm install 22        # 装项目声明的 v22
nvm use 22
cd D:\projects\windows-agent-orchestrator-poc   # nvm 会读 .nvmrc 自动切
node --version        # 应 v22.x

# 方式 B：fnm（winget 装）
winget install Schniz.fnm
# 给 PowerShell 加 fnm env（加到 $PROFILE）：fnm env --use-on-cd | Out-String | Invoke-Expression
fnm install 22
fnm use 22
cd D:\projects\windows-agent-orchestrator-poc   # 配 --use-on-cd 会按 .nvmrc 自动切

# 方式 C：不用管理器——直装 v22 LTS 覆盖
# 去 https://nodejs.org 下 v22 .msi 装即可（覆盖现有 node）
```

### 可选的 agent runtime（按需装，不装也能用其它 backend）

| runtime | 安装 | 用途 |
|---------|------|------|
| opencode | `npm install -g opencode-ai` | HTTP 类 backend（需先 `opencode serve`）；也可作为 MCP Lead host（见 §MCP stdio OpenCode 项目级配置） |
| claude code | 见 [anthropic 官方](https://docs.anthropic.com/en/docs/claude-code) | 进程式 backend（需登录：`claude login`） |
| codex | `npm i -g @openai/codex` | 进程式 backend（需登录：`codex login`） |
| kimi code | 见 [kimi-cli 官方](https://platform.moonshot.cn/) | 进程式 backend，多模态（需过 Kimi 白名单，无需登录命令） |

**你不需要全装。** 装一个就能用。不同 agent 可以用不同 backend。

#### Provider key（claude-code wrapper / opencode serve 需要）

claude-code 经 wrapper 调非 Claude provider（GLM/DeepSeek）时，wrapper 读 env 里的 key；opencode serve 也需 provider key。所需 env：`ZHIPU_API_KEY` / `DEEPSEEK_API_KEY` / `KIMI_API_KEY`（按你用的 provider 配）。**详细的 key 验证 / 注入 / 401 排错见 `docs/troubleshooting.md §1.2`**（用 `scripts/serve.ps1` 启动 serve 会从 User registry 读 key 注入）。`npm run cli -- wao doctor` 会查 key 是否在 env。

### 安装本工具

```powershell
git clone <repo> D:\projects\windows-agent-orchestrator-poc
cd D:\projects\windows-agent-orchestrator-poc
# WAO 含 MCP SDK/zod 依赖，clone 后必须安装：
npm ci
```

**一次性开发安装（M12-8F）：** 在 WAO 开发仓库内执行一次 `npm link`，即可在任何目录使用全局 `wao` 命令（它总是执行当前链接的这份 checkout）：

```powershell
cd D:\projects\windows-agent-orchestrator-poc
npm link
```

此后顶层命令可直接运行——如 `wao dashboard`（本启动器，见 §Owner 本地只读看板）——不必 `cd` 进 WAO 仓库，也不用担心 `npm run cli` 从其它目录报 "Missing script: cli"。注意只有顶层命令可用 `wao <command>` 形式；嵌套在命令族下的命令（如 `wao doctor`）仍需 `npm run cli -- wao doctor` 原形式。

**共享状态解析根（M12-8F）：** 经全局 `wao` 命令调用时，WAO 把 `config/default.json`、run 目录（`runs/`）与 agent registry（`config/`）从**受信安装根**（即 `npm link` 链接的这份 checkout）解析，而非当前目录。该安装根由 `bin/wao.js` 自身位置（`import.meta.url`）派生，作为子进程 env（`WAO_INSTALL_ROOT`）传给 CLI 子进程——不经 argv、不拼 shell 字符串，并覆盖调用方任何同名值（受信、不可注入）。因此 `--cwd` 仍只决定命令观察/过滤哪个 Git 项目（如看板按 ownership 过滤的目标 workspace），显式 `--run-dir`/`--registry` 覆盖照原样使用、不被重定位；`npm run cli -- ...`（不设该 env）保持从当前目录解析的遗留行为不变。

### 配置

**1. 复制 registry 模板并编辑：**
```powershell
Copy-Item config/agents.example.json config/agents.json
```

编辑 `config/agents.json`，把 `cwd` 改成你的项目目录，按需增删 agent。

> 第三方从全新 clone 只配一个 worker：`npm run cli -- wao onboarding --agent <agentId> --apply` 自动从入库模板生成单 worker registry + host-neutral MCP 片段（零手编）。正式验收链见 `AGENT_ONBOARDING.md` §9。

当前派发策略：
- 真实编码/文件修改/命令执行优先用 certified Claude Code worker（如 `coder_hq` / `coder_low`）。
- 标准角色以 `docs/team-roles.md` 为权威，配置落地以 `config/agents.example.json` 为模板。
- opencode worker 只作为 fallback / optional lane，用于需要 token 闸门精确控成本、且经过认证的特定模型任务。
- runtime/model 是否可进入 strict dispatch，以 `npm run reliability` 生成的 `runs/reliability-summary.json.workers` 为准。
- opencode stop 路径已有 TD-37/TD-38 后台 quietness 验证；派发前仍必须看最新 certification、`tokenBudget` 和 stop verification evidence。

**2.（可选）编辑 `config/default.json`** 调整全局默认值：
```jsonc
{
  "registry": "config/agents.json",
  "runDir": "runs",              // transcript 存放目录
  "pollInterval": 5000,          // opencode 轮询间隔 ms
  "waitTimeout": 300000,         // 默认等待超时 5 分钟
  "timeout": 30000,              // HTTP 请求超时
  "retries": 2,                  // HTTP 请求重试次数
  "defaultIsolation": "none",    // 默认不隔离（可选 "worktree"）
  "worktreeDir": null,           // worktree 存放目录（null = <cwd>/.wao-worktrees）
  "portRange": [30000, 31000]    // 端口分配范围（M5 用）
}
```

### registry 配置详解

每种 backend 需要的字段不同。完整角色矩阵不要在本文复制维护；以
`config/agents.example.json` + `docs/team-roles.md` 为权威。下面只保留最小形状示例：

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

    // ── claude-code（进程式，默认真实编码 lane）──
    "coder_low": {
      "backend": "claude-code",
      "provider": {
        "protocol": "anthropic-compatible",
        "baseUrl": "https://api.deepseek.com/anthropic",
        "apiKeyEnv": "DEEPSEEK_API_KEY"
      },
      "model": { "id": "deepseek-v4-flash", "contextWindow": 1000000 },
      "reasoning": { "effort": "max" },
      "cwd": "D:/projects/my-app",
      "args": ["--dangerously-skip-permissions"]
    },

    // ── codex（进程式）──
    "tester": {
      "backend": "codex",
      "cwd": "D:/projects/my-app"
    },

    // ── 带 worktree 隔离的 agent ──
    "coder_hq": {
      "backend": "claude-code",
      "cwd": "D:/projects/my-app",
      "args": ["--dangerously-skip-permissions"],
      "isolation": { "type": "worktree", "strategy": "persistent" }
      // strategy: "persistent"（默认，run 后保留 worktree）| "ephemeral"（run 后清理）
    }
  }
}
```

### 验证安装

```powershell
# 列出所有配置的 agent
npm run cli -- registry list --registry config/agents.json

# 检查 opencode serve 是否可达（只对 opencode-serve backend）
npm run cli -- registry check --registry config/agents.json

# 跑一次真实 smoke（消耗真实 API token）
npm run smoke           # 自动探测 claude/codex
npm run smoke -- claude # 只测 claude
npm run smoke -- --isolate  # 测 worktree 隔离

# 跑 runtime certification（消耗真实 API token）
npm run reliability
npm run reliability -- --profile strict
```

---

## 二、日常使用

### 所有命令都用 `npm run cli --` 前缀

```powershell
npm run cli -- <command> [options]
```

> **不要**直接 `node src/cli.js <command>`：系统默认 `node` 常是 v24（WAO 硬拒），`npm run cli` 走 v22 shim 才是可靠入口。下面为简洁省略前缀。

**已执行 `npm link` 后（M12-8F），优先用全局 `wao` 命令**：`wao <command> [options]` 与 `npm run cli -- <command> [options]` 等价（同一个 CLI、同一个 v22 shim），且可从任意目录调用。`npm run cli --` 嵌套形式仍完整保留。

### 场景 1：让 agent 做一件事并等结果

```powershell
# run = spawn + wait，打印 assistant 文本
npm run cli -- run coder_low --prompt "总结这个项目的 README"

# JSON 输出（含完整 messages + metrics）
npm run cli -- run coder_low --prompt "..." --format json
```

### 场景 2：后台跑（fire-and-forget）

```powershell
# spawn 不带 --wait，立即返回 runId
npm run cli -- spawn researcher --prompt "分析 auth 模块并列出风险文件"

# 之后查看状态
npm run cli -- status <runId>
npm run cli -- tail <runId>          # 看最后几个事件
npm run cli -- tail <runId> --follow # 实时跟踪
```

### 场景 3：并行跑多个 agent

```powershell
# 同时启动多个，--wait 等全部完成
npm run cli -- spawn researcher coder_low --prompt "审查这个函数" --wait
```

### 场景 4：worktree 隔离（每个 run 独立工作树）

```powershell
# 方式 A：命令行 flag（临时）
npm run cli -- run coder_low --prompt "..." --isolate

# 方式 B：registry 配置（持久）
# 在 agents.json 里给 agent 加 "isolation": { "type": "worktree" }
```

隔离后，agent 在 `<cwd>/.wao-worktrees/<runId>/` 里工作，不污染主工作树。

**Worktree checkout 卫生（M11-1B）**：WAO 在创建首个 worktree 前，会在仓库本地 `.git/info/exclude` 写入恰好一条根忽略规则 `/.wao-worktrees/`，使持久 worktree 目录不出现在源工作树的普通 `git status --porcelain` 输出。该规则是**稳定 repository-local hygiene 规则**（不编辑 tracked `.gitignore`、不隐藏任意 worker 产出；worktree 删除后仍保留）。WAO 保留既有 exclude 字节（含 BOM、CRLF/LF、用户规则），对已存在的精确规则幂等。`git worktree add` 失败时**保留该稳定规则，不回滚**——规则只在 exclude ensure 自身失败（write/read-back verify）时回滚到调用前字节。该规则与 host activation（如 Codex `mcp bind`）的 marker block 互相独立，移除一个不会影响另一个。

### 场景 4b：delivery 模式（foreground run + 原子交付 commit）

```powershell
# 1. 写 delivery spec JSON 文件
@'
{
  "mode": "git_commit_v1",
  "allowedPaths": ["src", "test/"],
  "verificationCommands": ["node --test test/example.test.js"]
}
'@ | Set-Content delivery-spec.json

# 2. 前台运行，--isolate 必须指定
npm run cli -- run coder_low --prompt "..." --isolate --delivery-spec-file delivery-spec.json --format json
```

Delivery 模式在 worktree 隔离中运行 worker，完成后打包一个 atomic delivery commit，
然后运行验证命令。`--format json` 返回完整 DeliveryRef 和 `verificationFailed` /
`verificationUnavailable` 标志。schema 语义见 `docs/02-architecture.md` §4.6-4.8。

WAO 会把 process cwd / `WAO_TARGET_CWD` 作为 delivery worker 的唯一授权 workspace。
Claude Code 的 Write/Edit/MultiEdit 会先记录 `write_intent`；只有同一 `toolCallId` 的成功结果
才确认 `file_written`。若写入意图无法关联、重复、超过 pending 上限、run 完成时仍未确认，
或 backend 报告的意图/已确认写入经词法路径和 filesystem realpath（含 junction/symlink）
不能证明位于该 worktree，run 会在 packaging 前以 `workdir_escape` 失败，transcript 只保留
固定安全事实、不保留越界路径。`write_intent` 不是“文件已写入”的证据。该检查不解析 worker
command，也不是 OS filesystem sandbox；它不会把语义判断或处置权从 Lead 手中拿走。

限制：仅支持 `run`（foreground 和 background 均可），不支持 `spawn`。Background delivery 需要 `--isolate`。

### 场景 4c：Lead 验收（delivery acceptance）

```powershell
# 查询 delivery 状态
npm run cli -- runs delivery <runId> --format json

# 接受（要求 verification passed + terminal completed）
npm run cli -- runs delivery <runId> --accept --reason-file accept-reason.txt --format json

# 拒绝（允许 passed/failed/unavailable verification）
npm run cli -- runs delivery <runId> --reject --reason-file reject-reason.txt --format json
```

Lead 验收通过 transcript-backed 原子 first-decision-wins 写入 `run.delivery_accepted` /
`run.delivery_rejected` 事件。`--reason-file` 必须是非空 UTF-8 文件。语义见
`docs/02-architecture.md` §4.9。

### 场景 5：重试 / 恢复

```powershell
# 重试：用原 run 的 prompt 重新跑一个新 run
npm run cli -- retry <runId> --wait

# 恢复：接续一个未完成的 run
#   opencode-serve：attach 到已有 session
#   claude/codex：重放原 prompt（进程式无法 attach，只能重放）
npm run cli -- resume <runId> --wait
```

### 场景 6：查看指标

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

### 场景 7：管理历史 run

```powershell
npm run cli -- runs list                    # 列出所有 run + 状态
npm run cli -- runs summary                 # 状态统计
npm run cli -- runs grep "error"            # 搜索 transcript
npm run cli -- runs prune --older-than 7d   # 清理 7 天前的 run
```

### 场景 8：daemon + 自愈（无人值守 / 长跑）

daemon 是常驻派发点（detached，CLI 退出不杀它），让 worker run 脱离单次 CLI 调用存活。supervisor
给它装自愈（崩了自动重启），health 给它装可观测（长跑泄漏告警）。**这是 P5（长跑 hardening）的能力**。

```powershell
# 起 daemon（detached，幂等）。--resume-on-start：重启时接管未完成 run。
npm run cli -- daemon start --resume-on-start

# 经 daemon 派发 worker（run 归 daemon 持有 → 出现在 daemon list，可被自愈保护）。
# 优先用这个而非 `run --background`（那个不经 daemon，daemon list 看不到）。
npm run cli -- daemon run coder_low --prompt "..."

# 查活 / 统一视图（含 external/orphan run）/ 单 run 状态
npm run cli -- daemon ping
npm run cli -- daemon list                 # 标 owner: daemon/external/orphan
npm run cli -- daemon status <runId>

# 自愈：spawn detached supervisor，daemon 崩/挂 → 自动重启（带退避防风暴）。
# 新 daemon 的 resume-on-start 接管未完成 run = 自愈闭环。
npm run cli -- daemon supervise
npm run cli -- daemon supervisor status    # 读 daemon-supervisor.json
npm run cli -- daemon supervisor stop      # SIGTERM supervisor（daemon 独立存活）

# 可观测：daemon 每 30s 采样（rss/heap/在飞 run/worktree 残留），超阈→warn（长跑泄漏信号）。
npm run cli -- daemon health               # dump 最新采样

# 停 daemon（IPC shutdown）
npm run cli -- daemon stop
```

**自愈边界**：supervisor 自身被杀（如机器重启）无法自拉——那种"重生引导"需 Windows 服务/计划任务，留 v2。
**可观测定位**：health 是"眼睛"（告警），不自动修泄漏根因——根因靠长跑 dogfood 暴露后针对性修（TD-46 原文）。
**无人值守长跑姿势**：`daemon start --resume-on-start` → `daemon supervise` → 派发任务 → `daemon health` 巡检。
（长跑 dogfood 本身需真实 token 预算 + 能盯着暴露的 bug，见 `docs/archive/m7-audit.md`。）

---

## 三、transcript 格式

> 本表是 transcript 事件类型的**完整权威定义**（spec 契约见 `docs/02-architecture.md` §3.2）。
> 其它文档（SKILL.md 等）引用事件时指向此处，不维护并行清单（SSOT）。

每个 run 的事件流存在 `runs/<runId>.jsonl`，每行一个 JSON 事件。完整事件类型：

| 事件 | 含义 | 阶段 |
|------|------|------|
| `run.started` | run 创建（含 backend/cwd/model/worktreePath） | M0 |
| `run.state_change` | 状态转移（from/to/reason） | M0 |
| `session.created` | backend session 建立 | M0 |
| `prompt.sent` | prompt 投递（含完整 prompt 文本） | M0 |
| `run.submitted` | 投递完成，进入等待 | M0 |
| `run.metrics` | token 用量 + 成本（旁路，不触发状态转移） | M4 |
| `run.event` | RunEvent 透传（含 command、write_intent、file_written、tool_use、tool_result；write_intent 仅是未确认的 containment telemetry） | M6/M12 |
| `scorecard.checked` | scorecard 门控结果（passed + checks），仅配了 rules 时写 | M6 |
| `run.completed` | 正常完成 | M0 |
| `run.timed_out` | 超时 | M0 |
| `run.aborted` | 被 abort | M0 |
| `run.error` | 错误 | M0 |
| `run.stop_requested` | 用户请求停止 | M0 |
| `run.wait_policy` | M10-pre：实际生效的等待超时策略（waitTimeoutMs + source: explicit/agent/global/disabled）。M10-pre3 起默认 disabled（waitTimeoutMs:null） | M10-pre |
| `run.stop_verified` | M10-pre：worker runtime 已确认静默；可能来自普通终态清理或显式 `run_stop`，不表示 Lead 一定调用过 stop | M10-pre |
| `run.stop_unverified` | M10-pre：worker runtime 未能确认静默（outcome: alive/probe_error）；可能来自终态清理或显式 stop | M10-pre |
| `messages.collected` | collect 命令拉取消息 | M0 |
| `run.rerun` | 进程式 resume 重放（originalSessionId → newSessionId） | M3 |
| `run.cleanup_done` | worktree 清理完成 | M3 |
| `run.delivery_created` | TD-103：delivery 打包成功——含完整 DeliveryRef | Phase 3A |
| `run.delivery_failed` | TD-103：delivery 打包失败——含 deliveryCode + message | Phase 3A |
| `run.delivery_verification_passed` | TD-103：delivery 验证通过 | Phase 3B |
| `run.delivery_verification_failed` | TD-103：delivery 验证失败（含 failureCode） | Phase 3B |
| `run.delivery_verification_unavailable` | TD-103：无验证命令（unavailableReason） | Phase 3B |
| `run.delivery_accepted` | TD-103：Lead 接受——含 updated DeliveryRef + deliveryCommit + reason | Phase 3C-2 |
| `run.delivery_rejected` | TD-103：Lead 拒绝——含 updated DeliveryRef + deliveryCommit + reason | Phase 3C-2 |
| `workflow.*` | DAG 节点级事件（workflow.started/completed、node.started/completed），独立 `wf_*.jsonl` | M5 |

> `run.message`：不是落盘事件类型——RunManager 把 message 的 role/parts 传给 scorecard 供 `requireAssistantText` 检查，不写进 transcript。

状态机完整定义见 `docs/02-architecture.md` §3.1；本文不复制状态列表。

直接读 transcript：
```powershell
npm run cli -- tail <runId> --limit 50
# 或直接
Get-Content runs\<runId>.jsonl | ForEach-Object { $_ | ConvertFrom-Json }
```

---

## 四、被脚本/LLM 驱动

本工具的设计目标之一是**可被任何调用方平等驱动**（bash 脚本、LLM 编排器、CI）。

所有命令都支持 `--format json`，输出机器可读：

```powershell
# spawn 返回 JSON（含 runId + transcript 路径）
npm run cli -- spawn coder_low --prompt "..." | ConvertFrom-Json

# run 的 JSON 输出含 messages + metrics
npm run cli -- run coder_low --prompt "..." --format json | ConvertFrom-Json
```

LLM 编排器（未来的 M5 DAG 或外部脚本）只需要：
1. `spawn` 启动 run，拿 runId
2. `status <runId>` 轮询状态
3. `collect <runId>` 或读 transcript 拿产出
4. `runs metrics <runId>` 拿成本

### MCP stdio 接口（agent-facing primary，M9）

WAO 是 MCP-first 控制面（Decision 0017）：一个 MCP host（如 Claude Desktop、Codex、OpenCode、其它 agent runtime）可通过 stdio 把 WAO 当作 MCP server 调用。MCP 暴露 22 个工具；常用 Lead 闭环为 inventory → workspace_status/select → dispatch → await result → delivery review bundle → acceptance，另有原子 status/wait/collect/activity/diagnose、delivery query/review/reverify、stop/list recovery、Lead 授权修正续跑 run_continue。built-in playbook catalog **不在工具面**——它是按需读取的 MCP resources（`wao://playbooks`，见下文）。`run_await_result` 是 advisory 只读便捷工具：一次调用等待终态（waitMs 0..270000，默认 270000；0 为 point-in-time）后返回安全 compact 终态结果 + 真实 run/liveness 观测，snapshot-only 零 audit，绝不 stop/decide/repackage；非终态时 Lead 可按任意合法 waitMs 再调，所有原子工具（run_wait/run_collect/run_status…）始终可用。`waitMs` 约束工具主动 sleep/poll 的总等待预算，而不是给每个内部阶段各分配一份预算；本地 transcript 文件读取与同步 snapshot 投影不能在 JavaScript 执行中途抢占，极端存储停顿可能让实际墙钟略超预算，工具不把这种环境延迟谎报成 worker 失败。`observationOutcome` 区分干净读取（observed）与 transcript 读失败（read_failure）；读失败时必带闭集机器码 `readFailureReason`（`transcript_parse_failed`=读取/JSON 解析异常、`legacy_event_shape`=历史非可用条目/快照形状不兼容、`snapshot_unavailable`=其他安全非解析类失败；observed 为 null），供 Lead 机器化决策——字段只含闭集码，绝不泄漏错误 message/path/command/credential，unexpected 内部异常仍保持固定 opaque 错误（M12-6 FR-08）。每个 tool 直接调用共享 application service，不 shell-out CLI。当前工具清单权威表见 `SKILL.md` 与 `docs/02-architecture.md`。

**M12-11 统一观察/终止事实**（`run_wait` 与 `run_await_result` 同形附加闭集字段，零 control/语义边界变更）：两者都附带 `observation: { outcome, waitedMs, windowMs }` 与 `termination: null | { state, source, configuredMs, policySource }`。`observation.outcome ∈ { point_in_time, window_expired, terminal, read_failure }` 让 Lead 不再猜测"窗口到期 / 终态 / 读失败"；`termination` **仅在干净观测到终态时非空**——窗口到期/读失败/transport 丢失一律 `null`，绝不折叠成 worker 已停止。`termination.source ∈ { completion, execution_deadline, manual, provider, backend, control_plane, unknown }` 是闭集终止来源（`execution_deadline` 仅当 WAO 截止定时器真触发；provider/backend/control_plane 由诊断 SSOT 投影，不含 raw error/reason/path/command/credential）。所有事实从**同一 snapshot** 派生并绑定 runId，零额外读、零 transcript 追加。`run_wait` 因此获得与 `run_await_result` 一致的 fail-closed 读失败语义（liveness/ownerHeartbeat 为 `unknown`，不拼陈旧事件 + 新鲜心跳）。Transport 恢复：若调用无返回结果，观察状态 unknown，这两个只读工具未做任何 control-plane 变更、未停 worker——point-in-time 重读 `run_await_result(waitMs:0)` 或 `run_status`，**绝不从 transport 丢失推断 worker alive/dead**。

**M12-9 三项机械增强**（均不改 control/语义边界，不新增门禁）：① `run_dispatch` 输入新增可选顶层 `executionProfileId`（与 `delivery` 同级；取自冻结可信 profile catalog，仅提供 delivery 验证的 setup/assertion 命令，与 inline `delivery.verificationCommands`/`delivery.verificationSetupCommands`/`delivery.verificationUnavailableReason` 互斥、仅 delivery 使用、派发前解析；未知/冲突由共享 resolver 稳定拒绝）；② 新增 advisory 只读工具 `run_dispatch_contract_check`（MCP adapter 在它与 `run_dispatch` 间共享输入 schema——service 自身不导入 Zod；service 复用同一 application 校验即共享 resolver + prepareDeliveryRequest，返回闭集 workspace/registry/contract 视图 + 有界 issue 码；`contractValid` 只反映 delivery/profile 机械合同，不预评 `expectedGitHead`/`expectedDirty`/`expectedWorkspaceRoot`、continuable/backend/session 资格或 worker 凭据——非门禁，sections 独立 settle 为 `observed`/`unknown`、`advisory` 恒为 `true`，零副作用，`run_dispatch` 不可依赖它，其部分失败不影响派发）；③ `run_await_result` 在终态且快照干净时附带有界闭集 `outcome`（terminalState / diagnosis(category/code/signalCount) / delivery(requested/readiness/available/failureCode/verificationStatus/verificationFailureCode/acceptanceStatus/decisionType) 安全事实；不含 commit id、changed paths、diff、command 文本、message/stderr、绝对路径或推荐，复用同一 snapshot 一次读取、零额外 transcript/Git 读、零 messages.collected 追加；非终态/read_failure → `outcome` 为 null）。**M12-13 增补**：`outcome.delivery` 追加 `isolationFailureCode`（闭集码或 null）——终端 delivery-requested run 且隔离违反为唯一较高优先级 delivery 事实时投影（见 `run_delivery` readiness `isolation_failed`），与 `deliveryFailure`（packaging 失败）严格分离。

**Host 注册说明**：`npm run mcp` 仅用于在 WAO repo 内手工 smoke；正式 host 注册应指向 Node shim 和 stdio entrypoint 的**绝对路径**，并为 registry 和 runDir 指定绝对路径——MCP host 的启动 cwd 不保证是 WAO repo。host 配置语法由 host 自己负责。注册后若当前会话未发现工具，重启或重载 host。Provider credential 必须由 host 通过其安全 env inheritance/allowlist 提供——不把 credential value 写入 repo、worker prompt 或 MCP args。WAO 不接管 host-global auth。

#### 冻结工具面（22 个 always-registered tools，M12-10 progressive-disclosure correction + M12-16 run_correct）

WAO 暴露**恰好 22 个 MCP 工具**，且它们**全部始终注册**：无 profile、无启动 flag、无 restart-to-recover——每个操作工具对连接的整个生命周期都可独立调用。这是一个**静态呈现层**：它**不是**权限层、**不是**路由层、**不按** host/runtime 名分支（Claude/Codex/Kimi/OpenCode 一视同仁，无任何 `if host==…`），也不依赖 `tools/list_changed` 或运行期动态注册。每个工具的 `name`/`description`/`inputSchema`/`outputSchema`/`annotations` 固定且逐字节稳定。

22 = 原 23 减去两个原 playbook 工具、M12-16 增 `run_correct`（queued in-flight correction）——built-in playbook catalog **整体移出工具面**，改为按需读取的 MCP resources（`wao://playbooks`，见下文）。这 22 个工具（含 `workspace_select`、`run_dispatch_contract_check`、`run_wait`、`run_correct`）不再被任何子集隐藏，因此一个永不重启的 Host 保留全部操作能力。所有 `DRILLDOWN_TOOLS` 闭集成员（`run_status`/`run_activity`/`run_collect`/`run_delivery`/`run_delivery_review`/`run_diagnose`）均在 22 集合内，故 `availableDrilldowns` 渐进式披露提示永远只广告可安全调用的观察工具；它只披露、不自动调用、不决策、不广告 mutation/control 工具。

单一冻结来源在 `src/mcp/toolSurface.js`（22 个名字的 frozen 数组 + 唯一性/计数/无 playbook 工具的模块加载不变量）；`server.js` 在构造期对实际注册序列做 deepEqual 自检，绑定 production 到该 SSOT。

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

#### OpenCode 项目级配置（host-local）

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

`registry_list` tool：

- **输入**：无参数。`registryPath`/`runDir` 是 server 启动配置，模型每次调用不能覆盖（由 server 持有）。
- **输出**：MCP `content`（text = JSON）+ `structuredContent`（同义对象），形状为：

```json
{
  "agents": [
    { "id": "coder_low", "backend": "claude-code", "model": "deepseek-v4-flash",
      "certification": "certified", "cwd": "/repo",
      "credentialAvailability": "available", "missingCredentialEnvNames": [],
      "providerReadiness": {
        "configurationStatus": "configured",
        "authenticationStatus": "unknown",
        "entitlementStatus": "unknown",
        "liveCheckStatus": "not_checked",
        "credentialAvailability": "available" } }
  ]
}
```

字段语义与 CLI `registry list --format json` 的数组元素一致（MCP 仅多一层 `agents` 包装）。`registry_list` 是只读操作，调用前后 runDir 不会有新增 transcript/run 文件。

**M11-7 凭据可用性**：`certification` 是历史可靠性认证结果，不等于"此刻可启动"。`credentialAvailability`（`available` / `missing` / `not_required`）只反映 worker **registry 显式声明为必需**的 credential（`provider.apiKeyEnv` / legacy `--api-key-env`）是否在当前环境可用——不声称 runtime 整体健康。优先 `process.env`，回退 Windows Current-User 环境，两处都缺失则为 `missing`；未声明必需凭据的 worker 为 `not_required`。**可选继承变量**（如 `OPENAI_BASE_URL`、`CODEX_HOME`、`KIMI_MODEL_NAME`）会被继承但不参与 missing gate——不会因缺少可选配置阻止派发。`missingCredentialEnvNames` 列出缺失的必需 env 变量**名**（绝不包含值）。`run_dispatch` 在 transcript 写入和 fork 前用同一 readiness 检查拒绝 `missing` 的 worker（零 transcript、零 fork），返回固定可行动错误。WAO 不保存/轮换凭据，不批量导入用户环境，只读取 registry 明确声明的精确变量名；设置或轮换凭据后**无需重启 Host**（每次评估重新观察当前状态）。

**M12-6 FR-02 provider readiness 真相（truth）**：`providerReadiness` 是严格投影对象，字段含义：
- `configurationStatus`（恒为 `"configured"`）——只证明该 registry 条目已配置，**不等于** worker 可运行；
- `authenticationStatus` / `entitlementStatus`（恒为 `"unknown"`）——本次 inventory **没有做任何 provider 探测**，因此**永远不得**宣称已认证/已授权；
- `liveCheckStatus`（恒为 `"not_checked"`）——本次调用**没有做 live check**；
- `credentialAvailability`——同 M11-7 语义，只证明必需凭据 env 名存在（或无需凭据）。

**语义铁律**：preflight/registry 查询"完成"只表示机械事实（registry 可读、必需凭据 env 名存在/不存在、配置条目存在）可读，**不是** authenticated/entitled/live-checked 的证明。本包不做 provider 网络请求、不读凭据值，所以结构上不可能投影出 `authenticated` / `entitled` / `checked`——MCP schema 的枚举直接派生自这些闭集常量（`src/application/registryInventory.js` 的 `CONFIGURATION_STATUSES` / `AUTHENTICATION_STATUSES` / `ENTITLEMENT_STATUSES` / `LIVE_CHECK_STATUSES`），不存在第二份手工维护列表。真实认证/授权状态只能来自实际运行/诊断（见 `run_diagnose` 的 `code`）。

### MCP `run_dispatch`（supervised background dispatch，M9-2B）

`run_dispatch` 让 MCP host 正式派发一个受监督的后台任务。它直接复用与 CLI `run --background` 相同的 application service（`dispatchRun()`），不 shell-out CLI。WAO 拥有 dispatch、detached runner 和 transcript；模型只提供 worker 和 bounded prompt。

**M11-5 角色合同自动注入（TD-89 修复）**：Lead 只需写具体任务 prompt，无需复制角色说明，也无需切换到 WAO 仓库目录。WAO 根据 registry 中 agent 声明的 `systemPrompt`（指向 `config/roles/*.md` 角色契约），用共享加载器（`roleContract.js`）验证并以 runtime-native 方式恰好一次注入 worker——claude-code 用 `--append-system-prompt <内容>`，codex 用 `-c developer_instructions`，kimi-code 用固定分隔组合 role+task，OpenCode 1.18+ 用 message API 原生 `system` 字段且 task 仍只在 user text part 出现一次。**路径权威**：相对 `systemPrompt` 由加载器相对 WAO 安装根解析（不依赖调用者 cwd），所以从 Life Index 等外部项目目录调用也能找到全局角色文件。是否支持注入由 backend 能力声明（`supportsRoleContract === true`）严格判定；能力值非严格 true 时，配了 `systemPrompt` 会在 start（创建 transcript 前）/ resume（读取既有 transcript 后、append/spawn 前）fail-closed。**WAO 不把角色合同保存为 `prompt.sent`/控制面输入**——transcript 只持久化原始 task prompt（注意：worker 输出可能在回答中引用或复述角色，这由模型决定）。Lead/model 不能通过 `run_dispatch` 覆盖角色（strict schema 不接受 `systemPrompt`/`roleContract`/`rolePath`）。

**Kimi K3 模型策略**：registry 用结构化 `model.id` 与 `reasoning.effort` 表达每个 worker 的模型策略。`kimi-code/k3` 的 `low` / `high` / `max` effort 由 backend 编译为仅对子进程生效的 `KIMI_MODEL_THINKING_EFFORT`；WAO 不修改全局 Kimi 配置，也不接受同名 `agent.env` 作为第二权威。K3 的上下文上限来自 Kimi Code 模型目录（当前为 1M），不是 WAO 的进程级 override，因此 registry 不重复声明 `model.contextWindow`。

`run_dispatch` tool：

- **输入**（strict schema，拒绝额外字段）：

```json
{ "agentId": "coder_low", "prompt": "bounded task prompt" }
```

M9-7A 起支持可选 `delivery` 块，用于派发后续可由 `run_delivery`/`run_delivery_decide` 操作的 delivery run：

```json
{
  "agentId": "coder_low",
  "prompt": "bounded task prompt",
  "delivery": {
    "mode": "git_commit_v1",
    "allowedPaths": ["src"],
    "verificationSetupCommands": ["npm ci"],
    "verificationCommands": ["npm test"],
    "verificationTimeoutMs": 600000
  }
}
```

`delivery` 可选。`verificationCommands` 与 `verificationUnavailableReason` 二选一（互斥）。WAO 强制 persistent worktree isolation——模型不能传 `isolate`。模型**不能**传 `registryPath`、`runDir`、`runId`、`cwd`、`workspaceRoot`、`requireCertified`、timeout 或 `isolate`——这些是 server-owned 配置。registry certification 是 **advisory 证据，不是 permission gate**：`registry_list` / `lead_preflight` 把每个 worker 的 `certification` 状态报告给 Lead，MCP dispatch/continuation 以 `requireCertified: false` 调 shared service，**不**强制认证——没有 reliability-summary.json 的 Fresh 克隆同样可派发（lead_preflight 已报告 configured/credential 事实，认证仅作参考）。显式 CLI `--require-certified` 与 RunManager 的 opt-in 认证门保持完整——CLI 或项目治理仍可要求认证。

**M12-13 per-command 执行预算（可选，`verificationTimeoutMs`）**：Lead 可选为 delivery 声明**单条 verification 命令的执行超时/预算**（整数 ms，共享闭界 `[1000, 7200000]`，默认 300000 **仅在字段缺失时**应用）。这不是 `run_wait` / `run_await_result` 的观察窗口——它约束 exact verifier 的逐条 setup/assertion 命令执行。语义：
- **验证先于副作用**：非法值（字符串/小数/越界）在派发/start/resume 的任何 transcript append、worktree 创建、spawn/attach、打包、验证之前经 `prepareDeliveryRequest` SSOT 拒绝（`invalid_verification`），零转录、零 worktree、零 spawn；
- **零漂移**：仅在显式声明时持久化（`run.started.delivery.verificationTimeoutMs`、`delivery_created` ref、verification outcome ref 都保留该值）；未声明则任何事件/ref 都不出现该字段，消费者才用默认值；
- **持久值权威**：贯穿 start / resume（resume 重新经 SSOT 校验，持久值损坏则 resume 直接拒绝 null，零副作用）、profile 折叠（profile 只供命令，Lead 声明的预算保留）、MCP/CLI 转发、`run_dispatch_contract_check` advisory 校验、`run_delivery_repackage` 原值重建与 verifier 调用、reverify 继承（省略 `timeoutMs` 时继承 ref 上持久化的预算，持久值损坏则 fail closed；显式值同样必须落在共享闭界内）；repackage 中字段缺失仍交给 verifier 默认值，字段存在但损坏则在 inventory/Git/transcript/verify 前拒绝；
- **无自动动作**：从不自动加宽、从不重试、从不因超时自动 stop/decision——超时结果如实投影为闭集 `command_timeout` / `setup_timeout`。

**M12-7 continuable 续谱根（delivery-only 可选）**：`run_dispatch` 顶层可带 `"continuable": true`（与 `delivery` 同级，不在 delivery 块内），把这次 delivery 标记为一条**可续谱系（continuable lineage）的根**。dispatch 会以 `run_lineage` / `turn:first` 建立一个 provider-native 会话（opaque uuid 由 server-owned Lead session + canonical workspace + canonical agentId + 该 run 的 rootRunId 派生），保留 retained worktree。这样日后 Lead 若审阅该终态 delivery、发现窄缺陷，可用 `run_continue` 对其续 ONE 修正回合——复用同一 retained worktree、以 `turn:resume` 续同一 provider 会话（同一 opaque uuid）。`continuable` 默认 `false`，省略时与普通 delivery dispatch 字节兼容；`continuable:true` 必须配 `delivery`（service 强制 delivery-only，否则 fail-closed）。WAO 从不在 dispatch 时推断或触发任何续跑/修正——是否续跑完全由 Lead 事后显式调用 `run_continue` 决定。

**verification 环境合同（M12-6 FR-05/FR-06）**：Lead 可选声明 `verificationSetupCommands: string[]`——在 assertion 命令（`verificationCommands`）之前顺序执行的"环境准备命令"（如 `npm ci` 安装依赖、生成构建产物）。setup 与 assertion 分开验证、持久化与投影：setup 失败投影为闭集 `setup_failed` / `setup_timeout` / `setup_environment_error`，**绝不**伪装成 assertion 的 `command_failed`，不泄漏命令体/路径/stderr。每条 setup 与每条 assertion 之后都重做 exact delivery commit / 受跟踪工件证明，任何 tracked artifact 或 lockfile 漂移 = `artifact_mutated`（setup 漂移时 assertion 不执行）。exact-artifact verifier 运行在**独立的 per-attempt 临时环境**：每次 setup / assertion 命令各创建唯一 temp 目录并注入 `TMP` / `TEMP` / `TMPDIR`，两个 attempt 不复用、不复用 worker temp，仅持久化安全布尔事实（不含绝对路径）。**依赖不继承**：selected / worker worktree 的 `node_modules` 等 ignored / untracked 依赖**不会**自动出现在 exact verifier 环境——需要 Lead 声明 `verificationSetupCommands` 来准备。

**Workspace binding（M10-pre2 + M11-6）**：`run_dispatch` 在调用 shared service 前**重新解析并证明** workspace（优先级：Lead 会话选择 `workspace_select`（`lead_session`）> MCP client roots/list 恰好一个合法 `file://` root（`mcp_root`）> 显式 `--workspace-root`（`server_config`）> 否则 fail-closed）。证明后的 canonical Git root 作为 `cwd` 传给 dispatcher。workspace 未绑定时 dispatcher 不会被调用（零 transcript、零 fork），返回固定安全文案。**M11-6**：Lead 可在当前会话用 `workspace_select` 选择 Git 项目（最高优先级），无需 Human Owner bind、无需项目配置、无需重启——失败选择不影响既有会话状态，也不写任何持久配置。

- **输出**（成功或拒绝同形，MCP `content` + `structuredContent`）：

```json
{ "runId": "run_...", "agentId": "coder_low", "accepted": true, "state": "pending" }
```

只返回 `runId`/`agentId`/`accepted`/`state`（M11-8B：`agentId` 是 transcript envelope 盖戳的 canonical worker 身份）。**身份绑定（M11-8B final）**：返回的 `agentId` 必须精确等于请求的 `agentId`——这是控制面对派发的身份绑定，不允许"合法但属于另一个 worker"的 id、missing/unknown/非法值；mismatch 一律折叠为固定 `run_dispatch failed`（`isError:true`、无 `structuredContent`、不泄漏返回值）。`run_dispatch` 永不返回 `"unknown"` 哨兵（那是 read 类工具的降级值）。不返回绝对路径、PID、prompt、argv 或内部错误。service 失败时返回固定安全文案 `run_dispatch failed`，不拼接原始 exception message、stderr、路径或凭据。

返回时 transcript 已可读且为 `pending`；关闭 MCP host 后，detached runner 独立驱动 worker 到终态（token 闸门/超时/兜底 abort 都生效），写入共享 transcript。Lead 用 MCP `run_status` 轮询状态。

annotations：`readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:true`（派发真实 worker，可执行命令、修改文件、访问外部系统）。

### MCP `run_continue`（Lead 授权修正续跑，M12-7）

`run_continue` 让 Lead 对一个**终态 continuable delivery** 续 ONE 修正回合。典型场景：Lead 审阅一个 delivery、发现窄缺陷（如一个漏改的边界条件），显式授权一次修正——WAO 创建**新** run/transcript，**复用父 run 的 retained worktree**（不开新 worktree、不开新 provider 会话），以 `turn:resume` 续同一 provider-native 对话，并打包新的 child delivery。MCP adapter 直接委托 application service `continueRun()`，不 shell-out CLI；M12-7 没有新增 CLI 子命令。

**Lead 语义唯一，WAO 不推断**：correction 的存在、范围、verification、retry、acceptance 全部由 Lead 决定——`run_continue` 只在 Lead 显式调用时发生一次，从不自动续跑、从不扩大范围、从不自动重试/接受/拒绝。child delivery 的 review/accept/reject 仍走 `run_delivery_review` / `run_delivery_review_bundle` / `run_delivery_decide`，归 Lead。

**续谱作用域（非 project-wide coder 复用）**：复用的是**这一条谱系**的 provider 会话——opaque uuid 由 server-owned Lead session + canonical workspace + canonical agentId + **root runId** 派生，跨一条 lineage 复用。它与 M11-11C 的 `lead_workspace` expert 复用是不同的 routing 模式（`run_lineage` vs `lead_workspace`），互斥：`continuable` 是 delivery-only，`lead_workspace` 是非 delivery。

`run_continue` tool：

- **输入**（strict schema）：

```json
{
  "parentRunId": "run_终态父run",
  "prompt": "Lead 授权的修正 prompt（bounded）",
  "delivery": {
    "mode": "git_commit_v1",
    "allowedPaths": ["src"],
    "verificationCommands": ["npm test"]
  }
}
```

`parentRunId` 必须是一个**终态**且 `continuable` 的父 run（其 `run_dispatch` 顶层带了 `continuable:true`）。已 accepted 的父 delivery 不可续；Lead 应为已接收成果另建新 run。`delivery` 必填（续跑总是 delivery run，child 会从谱系原始 baseCommit 打包累计 candidate，而不是只打包本轮 correction delta）。因此 child 的 `allowedPaths` 必须覆盖 Lead 批准的**累计 changed paths**（父成果 + 本轮修正）；WAO 不会替 Lead 推断或扩展范围。若 Lead 只列 correction delta，`disallowed_path` 会保留候选并等待 Lead 决定是否按累计清单重封装。模型不能传 workspace/registry/runDir/cert——这些 server-owned，由 MCP 边界从绑定 workspace 解析。

- **资格检查（read-only，先于任何 mutation）**：WAO 在 claim 续谱槽 / 转换 worktree / 写 transcript / fork 之前，以 closed-set `rejectionReason` 拒绝不合格的续跑：`malformed_input` / `invalid_delivery` / `parent_not_found` / `parent_not_terminal` / `parent_accepted` / `not_continuable`（父 run 非 lineage 续谱根，legacy 不可续）/ `no_provider_session` / `workspace_mismatch`（父 run 不属于当前绑定 workspace）/ `no_delivery`（父 run 缺 delivery 上下文）/ `worker_configuration_changed`（当前 backend/model 已不同，不能继承旧 provider session）/ `unsupported_backend`（backend 未声明 session reuse）/ `missing_worktree` / `worktree_drift`（retained worktree 丢失或 base/分支漂移）/ `busy`（同一谱系已有非终态 owner 在跑）。静态 argv 与 credential 检查也在 mutation 前完成；开始转换后若 transcript 或同步 spawn 失败，WAO 机械恢复父 worktree、删除 orphan child transcript 并释放谱系 claim。第二次 worktree 证明若发现外部漂移，只报告事实，不覆盖外部状态。这些 closed-set refusal 是**正常结构化结果**（`accepted:false` + `rejectionReason`），不是 MCP error；环境/内部执行错误仍保持既有固定安全错误边界。

- **输出**（成功 / 拒绝同形，MCP `content` + `structuredContent`）：

```json
{
  "accepted": true,
  "runId": "run_新child",
  "agentId": "coder_hq",
  "parentRunId": "run_终态父run",
  "continuation": true,
  "rootRunId": "run_终态父run",
  "state": "pending",
  "rejectionReason": null
}
```

成功返回新 child 的 dispatch 身份 + 谱系事实（`parentRunId` + `continuation:true` + `rootRunId`）。拒绝时 `accepted:false`、`rejectionReason` 为闭集码、其余成功字段为 `null`。**`busy` 只回 label，不回 active runId**——opaque provider uuid、Lead id、workspace 路径、active lineage runId、transcript 路径**永不**出现在 MCP 输出（与 `run_dispatch` reuse-busy 脱敏合同一致）。

- **retained-worktree 转换（幂等、崩溃安全）**：把父的 retained worktree 重新钉到 base 上、切到 child 分支 `wao/<childRunId>`，把父的 delivery/candidate 字节保留为 unstaged 工作改动；**父 commit 对象永不删除**，仍可按 SHA 审阅。child 从 base 打包自己的 delivery。

annotations：`readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:true`（续 provider 会话 + 在 retained worktree 上改动）。workspace-bound：父 run 必须属于当前绑定 workspace，否则 `workspace_mismatch`。

### MCP `run_correct`（运行中显式纠正，M12-16）

`run_correct` 让 Lead 对一条仍在执行、且派发时显式声明 `correctable:true` 的 run 发送一条**有界纠正消息**。它与 `run_continue` 不同：`run_correct` 不创建 child run、不切换 worktree、不重新派发 worker，而是把 Lead 明确提供的纠正写入原 run 的 durable transcript 队列，再由原 runner 串行投递给同一 provider 进程。普通 `run_dispatch` 省略 `correctable` 时保持原行为；backend 未声明 in-flight correction 能力时，`correctable:true` 在创建 run 前 fail closed。

输入是严格对象 `{runId, correctionId, prompt}`：`correctionId` 为 1..64 字符的 `[A-Za-z0-9_-]` 幂等键，`prompt` 为 1..15000 字符。相同 `correctionId` + 相同 prompt 可安全重查；同一 id 配不同 prompt 固定拒绝。工具只接受 workspace-bound、处于 submitted/running 阶段的 run；pending 尚未可投递，终态 run、未 opt-in run、跨 workspace run 或不支持的 backend 均返回闭集拒绝事实，不自动 retry、stop、continue 或改状态。

输出 `{runId, correctionId, outcome, reason}` 的 `outcome` 是 `queued | pending | delivered | rejected`。语义必须逐层区分：

- `queued` 只证明纠正已 durable append，等待 runner claim；
- `pending` 表示已有请求但尚无可确认的最终投递事实；
- `delivered` 只证明字节已送入 provider stdin，**不证明模型已读取、理解或执行**；
- `rejected` 携带闭集 `reason`，不回显 prompt、provider payload、session、路径或内部错误。

runner 以 requested → claimed → delivered/delivery_failed 的 durable 事件链串行处理；`run_activity` 只暴露安全的 correction 生命周期状态，不返回纠正正文。WAO 不判断纠正内容是否合理，也不会据此扩大 `allowedPaths`、改 verification、自动停止或接受交付；这些语义和最终决策仍完全属于 Lead。

annotations：`readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:true`（向正在运行的外部 provider 会话发送 Lead 指令；幂等性由 `correctionId` 绑定）。

### MCP `workspace_status`（workspace binding 状态查询，M10-pre2 + M11-6）

`workspace_status` 查询当前 workspace 绑定状态。只读、幂等——不修改任何持久状态。`run_dispatch` 在执行前**自行重新证明** workspace，不信任此工具的先前结果。

`workspace_status` tool：

- **输入**（strict empty schema，拒绝任何字段）：

```json
{}
```

- **输出**：

```json
{ "bound": true, "source": "lead_session", "workspaceRoot": "/abs/canonical/git/root", "gitHead": "abc123...", "dirty": false }
```

`source` 为 `"lead_session"`（Lead 会话选择）、`"mcp_root"`（client roots/list）或 `"server_config"`（显式 `--workspace-root`）。`workspaceRoot` 是当前绑定的 canonical Git 顶层绝对路径（Lead/host 已显式提交，非 credential，故返回）；`bound=false` 时 `source`/`workspaceRoot`/`gitHead`/`dirty` 均为 `null`。失败返回固定安全文案 `workspace_status failed`。

annotations：`readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false`。

### MCP `workspace_select`（Lead 会话级工作区选择，M11-6）

`workspace_select` 让 Lead 在当前 MCP 会话中选择工作 Git 项目（`lead_session` 来源，最高优先级）。**会话级**：只作用于当前 `createWaoMcpServer` 实例，两个 server 实例状态严格隔离；不写磁盘、不写 `.codex/config.toml`、不写 transcript、不创建 run/worktree/process，无需 host bind 或重启。验证委托 `proveWorkspace` SSOT——只接受 canonical Git 顶层（拒绝 relative/nonexistent/non-Git/subdirectory）。**失败选择不影响既有有效选择**（只在成功时更新）。幂等：重复选同一 repo 是 no-op。

`workspace_select` tool：

- **输入**（strict schema）：

```json
{ "workspaceRoot": "/abs/path/to/git/repo" }
```

`workspaceRoot` 必须为非空绝对路径（≤1024 字符）。

- **输出**：

```json
{ "bound": true, "source": "lead_session", "workspaceRoot": "/abs/canonical/git/root", "gitHead": "abc123...", "dirty": false }
```

失败返回固定安全文案 `workspace_select failed: workspaceRoot must be a canonical Git top-level directory`（不回显传入路径、stderr 或异常 message）。

annotations：`readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false`。

典型 Lead 流程：`workspace_status`（未绑定）→ `workspace_select(<current Git root>)` → `workspace_status`（确认 `lead_session`）→ `run_dispatch`。

### MCP `lead_preflight`（advisory 单调用启动检查，M11-8A）

`lead_preflight` 让 Lead 一次调用完成 workspace 选择/确认 + worker credential 可用性 + active-run 查询，替代机械地依次调用 `workspace_select`/`workspace_status` + `registry_list` + `runs_list`。**ADVISORY ONLY，不是 gate**：每项检查独立结算（一项失败不吞其他），输出是事实供 Lead 判断，绝不自动中止——不产生 permit/token/approval 状态，`run_dispatch`/`workspace_select`/`registry_list`/`runs_list` 不依赖它曾成功。`complete` 仅表示机械事实（registry 可读、必需凭据 env 名存在/不存在、active run 可数）是否可读取，**不是** authenticated/entitled/live-checked 的证明，也不是"是否应派发"的裁定——M12-6 FR-02：preflight 完成永不意味着任何 worker 已被认证/授权/做过 live check（每个 worker 的 `providerReadiness` 恒为 unknown/not_checked）。

`lead_preflight` tool：

- **输入**（strict schema）：

```json
{ "workspaceRoot": "/abs/path/to/git/repo" }
```

`workspaceRoot` 可选；提供时复用 `workspace_select` 的 workspace authority SSOT（`lead_session`），失败不覆盖既有有效选择。省略时只检查当前 session selection。

- **输出**（安全投影，不含绝对路径/credential value/prompt/command/PID/session）：

```json
{
  "workspace": { "bound": true, "source": "lead_session", "gitHead": "abc...", "dirty": false },
  "workers": [ { "id": "...", "backend": "...", "model": "...", "certification": "certified", "credentialAvailability": "available", "providerReadiness": { "configurationStatus": "configured", "authenticationStatus": "unknown", "entitlementStatus": "unknown", "liveCheckStatus": "not_checked", "credentialAvailability": "available" } } ],
  "activeRuns": [ { "runId": "...", "agentId": "...", "state": "running", "terminal": false, "updatedAt": "..." } ],
  "activeRunCount": 1,
  "activeRunsTruncated": false,
  "unresolvedRunCount": 0,
  "observations": ["..."], "warnings": ["..."],
  "manualChecks": ["workspace_status — ...", "registry_list — ...", "runs_list — ..."],
  "checkStatus": { "workspace": "observed", "workers": "observed", "activeRuns": "observed" },
  "complete": true
}
```

不返回 `PASS`/`FAIL`；check-level 状态为 `observed`/`warning`/`unknown`。`manualChecks` 指向原始 MCP 工具，允许 Lead 独立复核（与聚合结论不同时，Lead 可依据直接证据继续并记录 friction）。Active run、conditional worker、dirty workspace 只是事实，不自动禁止派发。

**M12-15 stale active-run truth**：`activeRuns`/`activeRunCount` 只计**经证明 active** 的 run——即 transcript 为已知非终态**且**有 fresh owner heartbeat（`ownerLiveness` SSOT，默认 10s 阈值）。一个非终态但缺少 fresh heartbeat 的 run（例如历史 6 月的 stale transcript）**不算** active，但也**绝不**据此推断它 failed/dead/stopped——它仍可能在长时间运行/休眠。这类 run 计入 `unresolvedRunCount`（与 `activeRuns` 同一次扫描/快照，Lead 无需重新扫描），并在 `unresolvedRunCount > 0` 时追加一条 advisory observation（说明这些 run 被排除出 `activeRuns`、不证明失败或停止，请用 `runs_list` 独立查看）。因此 `activeRunCount=0` 永远不应被误读为"工作区干净"——当 `unresolvedRunCount > 0` 时尤其如此。active-run 查询不可读时 `activeRuns`/`activeRunCount`/`unresolvedRunCount` 均为 `null`（unknown，绝不伪造为 0）。

### 项目级 Workspace Activation（M10 P0-1，**可选** Human Owner ops 命令）

> **M11-6 起，正常使用不要求先 bind。** Lead 可在当前会话用 `workspace_select` 选择 Git 项目（见上文 §`workspace_select`），无需 Human Owner bind、无需项目配置、无需重启。`mcp bind` 只是**可选的持久项目级默认**——为希望冷启动即自动绑定某项目的场景提供便利。

MCP workspace binding 来源优先级：`lead_session`（`workspace_select`）> `mcp_root`（client roots/list）> `server_config`（显式 `--workspace-root`）> fail-closed。`--workspace-root` 是全局静态启动参数。

`mcp bind/status/unbind` 命令让 Human Owner 在目标项目中执行**一次**（可选）项目级激活，生成一个 `.codex/config.toml` 中的 WAO managed block（含 `--workspace-root` 绑定到项目 canonical Git root）。这提供一个持久项目级默认——但不是正常使用的前置条件。

**前置条件**：项目必须是 Codex trusted project（在 Codex Desktop 打开一次即建立 trust）。详见 Codex 官方文档 `.codex/config.toml (trusted projects only)`。

**真实可执行入口**（当前没有全局 `wao` executable）：

```powershell
# bind: 在目标项目中生成 WAO managed block
& "D:\projects\windows-agent-orchestrator-poc\scripts\wao-cli.cmd" mcp bind --host codex --cwd "D:\path\to\repo"

# status: 查询绑定状态
& "D:\projects\windows-agent-orchestrator-poc\scripts\wao-cli.cmd" mcp status --host codex --cwd "D:\path\to\repo"

# unbind: 移除 WAO managed block（保留用户其它配置）
& "D:\projects\windows-agent-orchestrator-poc\scripts\wao-cli.cmd" mcp unbind --host codex --cwd "D:\path\to\repo"
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

### MCP `run_status`（point-in-time 状态查询，M9-3B）

`run_status` 让 MCP host 查询一个 run 的当前状态。它直接复用与 CLI `status` 相同的 application service（`getRunStatus()`），不 shell-out CLI。只读——不写 transcript、不修改任何持久状态。

`run_status` tool：

- **输入**（strict schema）：

```json
{ "runId": "run_..." }
```

模型**不能**传 `runDir`、registry、`follow`、`limit`、timeout 或其它控制参数——`runDir` 只能来自 server 启动配置。

- **安全输出**（只返回机器标识 + 时间戳，不含任何内容）：

```json
{
  "runId": "run_...",
  "state": "running",
  "terminal": false,
  "lastEvent": { "type": "run.event", "ts": "2026-07-14T00:00:10.000Z", "meaning": null },
  "lastActivity": { "kind": "command", "ts": "2026-07-14T00:00:10.000Z", "secondsSince": 4 }
}
```

`lastEvent`/`lastActivity` 在不存在时为 `null`。`lastEvent.meaning` 只对停止验证事件给出安全闭集解释：`runtime_quiet_verified|runtime_quiet_unverified|null`。因此 `type:"run.stop_verified"` 的稳定含义是“worker runtime 已静默”，它既可能来自普通终态清理，也可能来自显式 `run_stop`，不得据此推断 Lead 调过 stop。**M11-8B**：还返回 `agentId`——transcript envelope 盖戳的 canonical worker 身份（闭集字符 `[A-Za-z0-9._-]`，长度 1..128；`canonicalAgentId.js` SSOT）。只有每个事件都具备与请求 `runId` 一致的 `runId` 且同一个合法 canonical agentId 才返回该 id；缺失、冲突、非法或跨 run 一律降级为 `"unknown"`（不抛错、不伪造身份、不是自动停止门）。不从 worker 自由文本推断。**绝不返回**：原始 event payload、command/tool input/message/reason/error 内容、绝对路径、PID、prompt、argv、环境变量或 `lastActivitySummary`。这是有意的安全子集——CLI status 输出含人类可读摘要（含命令名/文件名），但 MCP 只暴露安全的机器字段。`content` 的 JSON 与 `structuredContent` 语义一致。service 失败时返回固定安全文案 `run_status failed`，不拼接异常 message/stack/path。

annotations：`readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false`（纯只读查询）。

### MCP `run_collect`（有界结果收集，M9-4B）

`run_collect` 让 MCP host 收集一个 run 的 worker 产出。它直接复用与 CLI `collect` 相同的 application service（`collectRunMessages()`），不 shell-out CLI。**不是只读**：每次成功调用追加一个 `messages.collected` 审计事件到 transcript（不改变 terminal state）；重复调用会再次追加（非幂等）。

`run_collect` tool：

- **输入**（strict schema）：

```json
{ "runId": "run_...", "cursor": "<opaque continuation token, optional, full only>", "mode": "<full|compact, optional, omitted≡full>" }
```

模型**不能**传 `runDir`、`limit`、`serveUrl`、`sessionId`、`cwd`、`raw`、`includeTools` 等——这些是 server-owned 配置。

- **安全有界输出**（只返回 assistant 文本 + 证据计数，不含原始执行证据）：

```json
{
  "runId": "run_...",
  "agentId": "coder_low",
  "backend": "process",
  "reconstructed": true,
  "itemCount": 12,
  "messages": [
    { "role": "assistant", "text": "bounded result text", "truncated": false }
  ],
  "evidenceCounts": { "message": 1, "command": 3, "toolUse": 2, "toolResult": 2, "fileWritten": 1, "other": 3 },
  "truncated": false,
  "nextCursor": null
}
```

**M11-8B canonical worker identity**：`agentId` 是 transcript envelope 盖戳的 canonical worker 身份——Lead 据此确认实际 worker，**不解析 worker 自由文本**（worker 可能自报 `/root`、`Coder-HQ`、显示名或完全不报，都不改变 durable `agentId`）。缺失/冲突降级为 `"unknown"`，不抛错、不伪造身份、不是自动停止门。`agentId` 来自 collect 已读的同一份 transcript 快照，不额外读 transcript/registry/文件系统。

边界：最多 8 条 message，每条 text 最多 4000 字符，全部 text 合计最多 12000 字符；超限设 `truncated:true`。只提取 assistant 角色 message 的 text part；assistant 文本经 secret redactor 脱敏当前进程环境中的凭据值。`messages:[]` 在无 assistant message 时是合法结果。

**M11-4 续读（continuation）**：当一次 collect 的结果超过单页边界（8 条 message、4000 字符/条、或 12000 字符总 cap），输出携带 `nextCursor: <opaque token>` 而非 `null`。Lead 用同一工具传 `{runId, cursor}` 继续读取下一页，直到 `nextCursor === null`。跨页拼接后完整、按序、无漏项、无重复；长单条 message 会在页内中途切分，下页从同一 message 的字符偏移继续；Unicode/CJK/emoji 不会在页边界拆坏 code point。cursor 是 server-opaque 的 base64url token（≤192 字符），只含 runId 摘要 + snapshot 摘要 + 位置索引，**绝不**含 raw runId/sessionId/path/prompt/secret 或任何 worker 文本；跨 run、跨 snapshot、跨位置重放都会 fail-closed 为固定 `run_collect failed`。cursor 是纯数据，Host/MCP 进程重启后仍可续读（无进程内 session 状态）。snapshot 在首次 collect 时冻结**完整 worker-authored raw 证据序列**（所有 message/command/tool_use/tool_result/file_written 事件，不只 assistant 文本）：若 worker 在分页期间继续追加 `run.event`，续读只读取冻结前缀，`itemCount`/`evidenceCounts` 与第一页完全一致（不漂移），不重复也不跳页；篡改历史事件（非追加）会 fail-closed。投影模式（MCP 总是；CLI `--format json`/`--cursor`）读取**完整** snapshot——不会在分页前截断为 50 条（pre-truncation 会永久隐藏早期消息）；legacy raw CLI `collect <runId>` 保持 `slice(-limit)` tail 行为不变。serve 后端的 `/message` endpoint 本身支持上游分页（`before` 游标 / `X-Next-Cursor`），但 WAO 当前的 `OpenCodeServeBackend.messages` adapter 选择单次 bounded `limit` 请求，**不消费上游分页能力**。投影模式用 cap+1 sentinel（10001）探测：返回 ≥ sentinel 条说明 run 超出当前 adapter 的安全容量（10000），**立即 fail-closed** 为固定 `run_collect failed`（零 partial、零 audit append），绝不把"只拿到 serve 尾部"谎报为"完整读完"。这是 WAO 当前 adapter 的有界策略，不是声称 OpenCode 不支持分页；未来 adapter 可消费上游分页以提升容量，但 M11-4 不实现该增强。process 与 serve 共用同一分页合同（算法 shape-driven，不按 runtime 名分支）。

**绝不返回**：command string/argv、tool input/tool output/tool result raw payload、file_written path、cwd、serveUrl、sessionId、PID、unknown event raw object、prompt、环境变量、异常 message/stack。`content` JSON 与 `structuredContent` 语义一致。service/投影/redaction/output validation 全部包在同一错误边界内；任何失败只返回固定 `run_collect failed`，不泄漏 SDK output validation error、原始异常、绝对路径或 secret。**任何**投影/schema 失败——包括 invalid cursor、cursor-less 第一页 service 成功但 projection 失败、output validation 失败——都**零追加** audit event。投影模式从第一页起一律 defer append，projection + output validation 全成功后才追加一次（M11-4）。

annotations：`readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true`（成功调用追加审计事件；serve path 可能读取外部 runtime 服务；但不杀进程、不修改 worker checkout、不改变 run terminal）。

**CLI 续读对等**：默认 `wao collect <runId>` 保持原 raw ops 输出（含完整 `data` 数组，供 ops/人读），并继续接受 `--limit N`（legacy tail 语义，`--limit 0` = 全部）。机器可读的续读入口是 `wao collect <runId> --format json`（首页）和 `wao collect <runId> --cursor <token> --format json`（续读页）；两者委托与 MCP 相同的 `projectCollectResult`，输出结构（messages/evidenceCounts/itemCount/truncated/nextCursor）与 MCP `structuredContent` 深度语义一致。投影模式是 strict parser：`--cursor`/`--format` 缺值或空值在读取 transcript 前即拒绝（不静默退回 raw collect）；`--limit` 在投影模式被拒绝（pagination 由投影层固定，用户 limit 会与之冲突）；未知 flag、重复 flag、多余 positional 均拒绝。投影模式从第一页起 defer audit append，projection + output validation 全成功后才追加一次。

**M12-2A compact 模式**：可选输入 `mode` ∈ `{full, compact}`（省略 ≡ `full`）。`compact` 在**一次调用**内返回最后一条 assistant 文本（经与 full 完全相同的 redaction + C0/C1/DEL sanitization 后的原样文本，≤4000 字符）以及来自**同一份完整安全快照**的 `evidenceCounts`/`itemCount`——让 Lead 在终态后通常只需一次 collect 即可看到 worker 的最后结论与完整证据计数，而非 6-9 页 full 收集。compact **复用** full 的 `extractAssistantTexts`/脱敏/sanitization/`evidenceCounts` SSOT（不复制解析算法、**不做语义摘要**、**不决定**是否需要 full 输出）。compact **不接受 cursor**（cursor 仅 full 可带）；`compact+cursor` 在 service/read/append 之前 fail-closed 为固定 `run_collect failed`，非法 `mode` 同样 fail-closed。compact 输出在 full 全部安全 base 字段之外，**仅 compact** 额外返回三个字段：

```json
{
  "runId": "run_...", "agentId": "coder_low", "backend": "process", "reconstructed": true,
  "itemCount": 12,
  "messages": [ { "role": "assistant", "text": "<last assistant verbatim, ≤4000 chars>", "truncated": false } ],
  "evidenceCounts": { "message": 4, "command": 3, "toolUse": 2, "toolResult": 2, "fileWritten": 1, "other": 0 },
  "truncated": false,
  "nextCursor": null,
  "view": "compact",
  "compactStatus": "available",
  "assistantMessageCount": 3
}
```

`compactStatus` 为闭集三态：`available`（≥1 条 assistant 文本，且最后一条 ≤4000 字符 → `messages` 恰好一条完整原样文本，`truncated:false`）；`empty`（无 assistant 文本 → `messages:[]`）；`too_large`（最后一条 >4000 字符 → `messages:[]`，**不**给部分文本、**不**给 cursor）。三态均为 `truncated:false`、`nextCursor:null`；`assistantMessageCount` = 完整快照中 assistant 文本条数（注意它与 `evidenceCounts.message`——所有 message-shape 条目含 user——不同）。每个 compact **成功**严格追加**一个** `messages.collected`；任何 input/投影/schema/service 失败（含 `compact+cursor`、非法 `mode`、serve sentinel ≥10001）追加**零**个（投影模式 defer append，projection + output validation 全成功后才提交）。compact 不是摘要、不是 final-answer 决策，也不替代 full 续读。

**CLI compact 对等**：`wao collect <runId> --mode compact` 进入与 MCP 相同的 compact 投影（`--mode compact --format json` 等价；`--mode` 单独即触发投影模式）。`--mode full` 与现有 `--format json` 机器投影兼容。strict parser：`--mode` 缺值、非法值（非 `full`/`compact`）、`--mode compact --cursor`、未知 flag、重复 flag 均在读取 transcript 前拒绝；默认 raw `wao collect <runId>` 保持不变。

### MCP `run_diagnose`（安全确定性诊断，M9-5B）

`run_diagnose` 让 MCP host 诊断一个 run 的失败原因分类。它直接复用与 CLI `runs diagnose` 相同的 application service（`getRunDiagnosis()` → `diagnoseFailure()` 内核），不 shell-out CLI。只读——不追加 transcript event、不修改 terminal state、不给处方或建议。

`run_diagnose` tool：

- **输入**（strict schema）：`{ "runId": "run_..." }`。模型不能传 runDir/raw/includeEvidence/recommend/retry/worker/strategy 等。

- **安全输出**（只返回机器字段，不含 raw evidence fact）：

```json
{
  "runId": "run_...",
  "state": "failed",
  "terminal": true,
  "category": "provider_auth",
  "code": "subscription_access_disabled",
  "signalEventTypes": ["run.event", "run.error"],
  "signalCount": 2,
  "signalsTruncated": false
}
```

`category` 来自 `DIAGNOSIS_CATEGORIES` SSOT（13 类 enum，包含 delivery worktree 越界的 `workdir_escape`）。`signalEventTypes` 只保留 evidence 的 event type（最多 8 条，每条 ≤64 字符，异常映射为 `unknown`），**绝不返回** raw fact/error/detail/reason/check name/command/tool payload/path/timestamp/prompt/PID/sessionId/provider stderr/环境变量，也**绝不返回** recommendation/advice/retry/nextStep。`content` JSON 与 `structuredContent` 语义一致。失败返回固定 `run_diagnose failed`。

**M12-6 FR-02 诊断码（`code`）**：可空闭集字段，仅当 `category === "provider_auth"` 时非 `null`，取值必须属于 `PROVIDER_DIAGNOSIS_CODES` SSOT（`src/diagnosis.js`）：`subscription_access_disabled`（组织禁用了 Claude subscription access）、`organization_policy_denied`（组织策略拒绝）、`api_key_missing`（必需 API key 缺失）、`unauthorized`（401/身份验证失败）、`invalid_credential`（无效 key/credential）。其他类别恒为 `null`。`code` 是**事实标签**——把此前被误归 `no_effect` 的 entitlement 拒绝（无 401/unauthor 字样、含 "Your organization has disabled Claude subscription access ..." 等真实文本）稳定归类为 `provider_auth` 并给出可机读原因；它**永远不**回显原始错误文本/path/command/key/payload，服务返回的非法/越集 code 一律折叠为 `null`（fail closed）。CLI `runs diagnose` 显示同一 category 与 code。

annotations：`readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false`（纯只读查询，不触碰外部系统）。

### MCP `run_delivery`（只读 delivery 查询，M9-6B + M11-1A + M11-10）

`run_delivery` 让 MCP host 查询一个 run 的 delivery 状态。只读，不追加 transcript event。

- **输入**（strict）：`{ "runId": "run_...", "waitMs"?: 1000..300000 }`。`runId` 必填；`waitMs` 为**可选**整数（共享常量锁定区间 `[1000, 300000]` ms，server-owned，模型不可越界）。省略 `waitMs` → 保持现有 point-in-time 输出（M9-6B + M11-1A + M11-8C，向后兼容）；提供 `waitMs` → 触发 bounded read-only readiness wait（M11-10）。MCP 自身不解析 transcript、不 shell-out CLI——只委托同一份 application service。
- **安全输出**（不返回完整 DeliveryRef / raw diff / file content / reason / commands / results / worktreePath / branch /integration）：

```json
{
  "runId": "run_...",
  "deliveryAvailable": true,
  "deliveryRequested": true,
  "terminalState": "completed",
  "baseCommit": "bbb...",
  "deliveryCommit": "ddd...",
  "changedFileCount": 3,
  "changedPaths": ["src/a.js", "src/b.js", "test/a.test.js"],
  "changedPathsTruncated": false,
  "verificationStatus": "passed",
  "verificationFailureCode": null,
  "verificationFailureSummary": null,
  "acceptanceStatus": "pending",
  "decisionType": null
}
```

字段：

- Commit hash 校验为 40/64 位十六进制。
- `changedFileCount` = DeliveryRef 中全部 changed files 的真实总数（不受 cap 影响）。
- `changedPaths` = 最多 **64** 条、确定性顺序（与 DeliveryRef 的 sorted canonical 顺序一致）、repo-relative、forward-slash 的安全路径。这是 review metadata，**不是 raw diff 或文件内容**。64 cap 是 server-owned 常量，模型不能通过 tool argument 控制。
- `changedPathsTruncated` = `changedFileCount > changedPaths.length`（即真实总数超过 64 cap）。
- `verificationStatus` ∈ `pending|passed|failed|unavailable`；只有 `passed` 表示 exact-artifact verification 已通过，Lead 仍负责语义判断。
- `verificationFailureCode` ∈ 安全 enum 或 null；`decisionType` ∈ `run.delivery_accepted|run.delivery_rejected|null`。
- `verificationFailureSummary`（M11-12B，nullable）仅当 `verificationStatus === "failed"` 时非 null，是**安全事实摘要**——让 Lead 定位哪个声明检查失败，但绝不泄漏命令文本/stdout·stderr 内容/signal/path/env/credential/prompt/动态错误。严格 8 键对象，且仅含安全标量：`code`（与 `verificationFailureCode` 同一闭集投影；`failed` 时缺失/非法/未知一律为 `unknown`）、`failedCommandIndex`、`declaredCommandCount`、`executedCommandCount`、`exitCode`、`timedOut`、`stdoutBytes`、`stderrBytes`。`exitCode` 保留 Windows 非负 32 位值（含 9009；不按 POSIX 0..255 截断），负/小数/非数/`> 0xffffffff` 一律 null。per-command 字段（`exitCode`/`timedOut`/`stdoutBytes`/`stderrBytes`）仅当 `results[failedCommandIndex]` 是 `result.index === failedCommandIndex` 的 plain object 时投影；不匹配/缺失/malformed 时保留 counts/index/code 但置空这四个字段。malformed 数据 fail-safe 且向后兼容（非 failed 状态为 null）。无产品 vs 环境分类、无处方/重试/stop/accept-reject、无新工具/日志子系统。

路径投影的安全边界：每个 path 经 `src/delivery.js` 的 repo-relative 校验 SSOT 复验（拒绝绝对 Windows/POSIX/UNC、`..`/`.` traversal、空 segment、尾分隔符），并额外限制长度 1..512、无控制字符、无 NUL、统一 forward-slash。任何 malformed path 一律 fail-closed —— 整个 projection 不返回部分结果，调用折叠为固定 `run_delivery failed`，不泄漏恶意值。失败返回固定 `run_delivery failed`（不拼接异常、路径或 secret）。

**M12-13 isolation_failed（隔离违反 readiness）**：终端（已到终态）且已请求 delivery 的 run，若其**唯一**较高优先级 delivery 事实是恰好一条 run-bound 的安全 `run.isolation_violation`（顶层 durable `code` 为闭集 `workdir_escape` 字符串），readiness 立即 settle 为 `isolation_failed` 并投影 `isolationFailure:{code:"workdir_escape"}`——这是与 packaging failure（`deliveryFailure`）**严格分离**的第三类失败形状。规则：任何既有 delivery 事实（delivery_created / verification outcome / packaging failure / Lead decision）**优先于**隔离事实；isolation_violation 缺失、多于一条、跨 run、code 非安全闭集或顶层 `code` malformed → fail-closed 折叠为 `ambiguous`。`isolation_failed` 意味着**无 packaging、无 diff、无 review、无 decision 面**——不出现 `candidateInventory`、不触发 repackage/salvage/retry/stop/decision 任何动作，Lead 只能另行派发。`run_await_result` 的 `outcome.delivery.isolationFailureCode` 投影同一事实（无隔离失败时 `null`）。

**结构化无交付 / packaging failure**：`deliveryRequested` 明确区分本次 run 是否声明过 delivery。普通非 delivery run 返回 `deliveryAvailable:false, deliveryRequested:false, deliveryFailure:null`，这是正常查询结果而非错误；已请求但尚未打包则返回 `deliveryAvailable:false, deliveryRequested:true, deliveryFailure:null`。当存在绑定当前 runId 的 durable `run.delivery_failed`（如 `base_commit_mismatch`），返回 `deliveryAvailable:false, deliveryRequested:true` + `deliveryFailure.code`（闭集安全 code，未知/损坏/注入 code 投影为 `unknown`，不回显原值）。transcript 缺失/损坏或 durable 事实冲突仍固定返回 `run_delivery failed`。`run_delivery_decide` 在没有 DeliveryRef 时仍不可调用成功。`run_diagnose` 对 packaging failure 返回 `category:"delivery_packaging_failed"`（只给事实不给处方/重试）。

**Candidate inventory（M12-1S1/M12-4A 附加只读投影）**：可恢复候选附加 nullable `candidateInventory` 与 `candidateKind:"disallowed_scope"|"backend_failed"`——持久化的**原始批准路径**、candidate 的**实际**改动路径（相对持久化原始 base 的 tracked diff + 非 ignored untracked，两次必需 Git read 都成功才产出），以及其中超出原始合同的子集。`disallowed_scope` 来自绑定的 `disallowed_path` packaging failure；`backend_failed` 只来自已请求 delivery、唯一终态 `failed` 原因为 `backend_error|backend_stream_ended`、存在绑定 `run.stop_verified` 且无 stop/isolation/budget/scorecard/既有 delivery chain 冲突的 retained worktree。形状：`{ originalAllowedPaths, originalAllowedCount, originalAllowedTruncated, actualChangedPaths, actualChangedCount, actualChangedTruncated, disallowedPaths, disallowedCount, disallowedTruncated }`；每条路径列表 cap 256（wire schema `maxItems:256`/`maxLength:512` 可见），count 永远是去重排序后的完整基数，truncated 精确反映截断。它是**纯 advisory 事实**：null 表示 Lead 人工核实，绝不自动 scope 扩展/repackage/stop/retry/decision/推荐。失败关闭规则：workspace ownership、恰好一个绑定 `run.started`（含可用 delivery 上下文）、linked-worktree-at-base 证明（worktree HEAD 恰好等于持久化原始 baseCommit）任一失败、任一必需 Git read 失败、任一路径未过严格投影 SSOT（`validateProjectedPath`），或 backend 候选 inventory 为空/任一列表截断 → 整个候选投影为 null（绝不部分真实）；无 authority => null 且零 worktree/Git read。其它 failure code、success 和非候选状态不携带候选字段；point-in-time 与 waitMs readiness 两条路径投影一致。严格只读：transcript 字节、HEAD/branch、index/worktree 内容不变。

**M11-10 delivery readiness handshake（可选 bounded 只读 wait）**：提供 `waitMs` 时，`run_delivery` 在同一份共享 application service（`getRunDeliveryReadiness`，CLI/MCP 共用）内做 bounded read-only readiness wait，并额外返回：

```json
{
  "runId": "run_...",
  "readiness": "reviewable",
  "waitReturnedEarly": true,
  "terminalState": "completed",
  "deliveryAvailable": true,
  "deliveryRef": null,
  "deliveryFailure": null,
  "isolationFailure": null,
  "verification": { "status": "passed" },
  "acceptance": { "status": "pending" }
}
```

- `readiness` 为严格闭集 `waiting_for_packaging | waiting_for_verification | reviewable | packaging_failed | isolation_failed | not_requested | ambiguous`（消费方必须视其为穷举，任何其它值都是 bug；`isolation_failed` 为 M12-13 新增，见上）。
- `reviewable` 仅当存在 durable `delivery_created` **且**恰好一个绑定该 runId 的最终 verification outcome（passed/failed/unavailable），并复用共享 `validateDeliveryFacts` SSOT 作为最终权威；failed/unavailable 仍为 reviewable（不自动 reject，Lead 仍负责 accept）。
- 冲突或不完整的 durable 事实（多个 created/verification/packaging failure、commit 不匹配、跨 run ref、created+failed、有 verification outcome 但无 bound created，或 run 已终态但声明的 delivery 没有 created/failed 结果）折叠为 `ambiguous`（fail-closed，不回显动态值）；后者会立即返回，不耗尽 wait 窗口。
- wait 是 workspace/runId-bound、非忙等（两次 re-read 之间 sleep）、**零 transcript append**、bounded polling（deadline = 起始时间 + waitMs）。MCP 长 wait 复用 `run_wait` 的 SDK-native progress/timeout 模式（`notifications/progress` keepalive + `resetTimeoutOnProgress`）；`waitMs` 区间由共享常量 `DELIVERY_WAIT_MS_MIN=1000`/`DELIVERY_WAIT_MS_MAX=300000` 锁定，zod schema 与 service 业务边界都从同一常量构造，不可漂移。
- pending-at-deadline 是**诚实的事实**（`waitReturnedEarly:false`），不是错误；wait 绝不 stop/retry/accept/reject。初始读取失败即抛错（不进入 wait）；wait 期间某次 re-read 失败时，不把 stale waiting 快照伪装成 deadline 到期，而是 fail-closed 为 `ambiguous` 并提前返回（`waitReturnedEarly:true`，不回显错误、不重试）。
- 安全投影复用既有 `run_delivery` 投影（commit/path 校验、redaction、闭集、fail-closed 不变）；`run_delivery_review` 的 exact-proof / 安全投影 / 错误边界**未被放松**。

CLI 等价：`runs delivery <runId> --wait-ms N [--format json]`（`--wait-ms` 缺值或非整数/越界在 service 调用前拒绝；省略 `--wait-ms` 时保持旧 point-in-time 形状，无 `readiness` 字段）。

annotations：`readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false`。

### MCP `run_activity`（Lead 有界活动时间线，M12-8A）

`run_activity` 是 workspace-bound、只读、幂等的活动下钻工具。它从**同一份 transcript 快照**投影一页事实，不追加 audit，不直接返回 JSONL，也不做进度估计、总结、建议或下一步裁决。

- 输入：`{runId, categories?, afterSeq?, cursor?, pageSize?}`。`categories` 是 `message | command | tool_use | tool_result | file_written | runtime_status | state | other` 的闭集；`pageSize` 为 1..50；`cursor` 是由上一页返回的 opaque token。
- 输出：当前 state/terminal、八类总计、当前页 entries、`truncated`/`nextCursor` 和 `availableDrilldowns`。message 只给脱敏后的有界文本；command 只给 `ok|failed|unknown`，不返回 argv；tool 只给名称/错误布尔；文件只给安全 repo-relative path；`runtime_status` 只给 `initialized|streaming|provider_retry|unknown`，不返回 stream delta/retry error/session/model；未知事件只用固定 sentinel。
- 安全顺序：完整动态文本先 exact-secret redaction，再清洗 C0/C1/DEL，再截断/分页。绝不返回 raw command、tool input/output、error text、credential、PID、provider session 或绝对路径。
- cursor 绑定 runId、冻结快照前缀、audience/filter/afterSeq 视图和位置；append-only 增长可继续，历史变更/收缩、跨 run/view/audience、malformed 或越界 cursor 固定失败。Lead 可任意时点重复读第一页，或沿 `nextCursor` 逐页下钻。
- `scopeObservation`（M12-14，advisory、additive）：闭集 `within_declared_paths | outside_declared_paths | unknown`，`source` 恒为 `"transcript_file_events"`，附 `observedFileCount`、`outsidePaths`（脱敏后的安全 repo-relative 路径，上限 25 条）/`outsidePathCount`/`outsidePathsTruncated`。`complete:true` 的准确语义：观察到的 transcript 快照已是**终态**，且该快照中每一条确认的 `file_written` 路径都能在**恰好一个有效合同权威**（绑定 runId 的 `run.started` 绝对 worktreePath + 非空合法 `delivery.allowedPaths`）下求值；它**不**证明文件系统完整性、语义正确性、交付验证或 Lead 验收，也**不**表示 worker 仍在运行（`complete` 的前提是快照终态）。快照未终态或任一确认路径无法求值 → `unknown`（`complete:false`）。

### Owner 本地只读看板（M12-8C/D/F）

人类 Owner 可在 WAO 仓库入口启动本地网页，而不把完整 worker 活动灌入 Lead context。**主用命令（M12-8F，需一次性 `npm link`，见 §安装本工具）**：

```powershell
# 在目标 Git 项目内（或任意目录加 --cwd 指向 Git 项目）
wao dashboard
wao dashboard --cwd "D:\path with spaces\project"   # 从任意目录启动
wao dashboard --no-open                             # 启动但不自动打开浏览器
wao dashboard --port 8123 [--run-dir DIR]           # 固定端口 / 自定义 run 目录
```

行为契约：

- 目标目录默认是当前目录（`process.cwd()`）；`--cwd` 显式指定目标项目。目标必须在某个 Git 仓库内——命令解析出 canonical Git root 作为看板 workspace（嵌套子目录也自动解析到仓库根）；**不在 Git 仓库内时，在监听之前就失败**并给出可操作提示（在 Git 项目内运行，或用 `--cwd`）。
- **run/registry 来自安装根（M12-8F）**：经全局 `wao` 调用时，看板读取的 run 目录与 agent registry 从受信安装根解析（见 §安装本工具「共享状态解析根」），不会静默落到当前目录的 `runs/` 或 `config/`；当前目录仅作为默认 target workspace（`--cwd` 可覆盖），显式 `--run-dir` 覆盖照原样使用、不被重定位。
- 默认在 Windows 默认浏览器打开生成的 fragment-token URL **恰好一次**（无 shell 拼接，URL 只作为结构化 argv 传给系统默认处理器）；`--no-open` 不做任何打开尝试。打开是 spawn 型的：处理器子进程在 spawn 后即被 unref，即使默认处理器进程滞留也不会阻塞本命令的 Ctrl-C 关闭。
- 浏览器打开失败只是提示：URL 已打印，打印一行简短警告后服务器继续运行，按 `Ctrl-C` 停止。
- **已接受的瞬时本机暴露（如实披露）**：生成的 fragment-token URL 会打印给人类 Owner，并会短暂出现在本地 `rundll32` 子进程的命令行中（Windows 上本机其它进程/工具可瞬时读到该命令行）——这是让默认浏览器打开该 URL 的必要传递方式。服务边界未因此改变：服务器仍只监听 `127.0.0.1`，token 生命周期随服务器关闭（Ctrl-C/进程退出）结束，看板 API 只接受带该 bearer 的只读 GET。

旧式嵌套命令仍支持（不会自动打开浏览器，非 Git 目录仍 fail-soft 启动）：

```powershell
npm run cli -- runs dashboard --web [--port 0|1024..65535] [--run-dir DIR] [--cwd GIT_ROOT]
```

命令打印一次 `http://127.0.0.1:<port>/#token=<64hex>` 和停止提示；在浏览器打开该 URL，按 `Ctrl-C` 关闭。省略 `--port` 时使用临时端口。`--web` 不与 `--watch` 或 `--format json` 共用，也不会自动打开浏览器。

看板展示当前 workspace 的最近 runs、状态、最后活动和有界详细消息，支持筛选、选择 run、继续读取旧页与自动轮询；移动端 recent-runs 区域独立滚动。选中 run 的详情面板给出 backend、execution stage、terminal、事件总量、scope observation、liveness 与有界活动时间线；这些均是 transcript/application projection 的只读事实，不是语义进度判断。它调用与 `run_activity` 相同的读取/分类/redaction/cursor SSOT，只使用 Owner 较大的 excerpt/page 默认值，不直接读 JSONL。

M12-17 增加**人类显式 opt-in** 的浏览器终态通知：只有 Owner 点击启用且浏览器授予 Notification permission 后，页面才在观察到同一选中 run 从非终态变为终态时通知恰好一次；首次加载/刷新时已终态的 run 不补发，重复 polling 不重复发送，拒绝权限会明确显示 `notifications blocked`。通知只含固定安全字段，不含 worker 消息、路径、command/tool payload、credential 或 session。所有异步 activity 请求同时绑定选中 `runId` 与 selection epoch，A→B→A 快速切换时，旧响应不得覆盖当前 run 的详情。

安全边界：服务只监听 `127.0.0.1`，API 要求每进程随机 bearer；token 只从 URL fragment 进入 `sessionStorage`，不进 query/server log/localStorage。服务仅接受 GET 和严格有界 query，固定静态资源、no-store/nosniff/no-referrer、严格 CSP、无 CORS opt-in。页面没有 mutation 控件；不会 stop/retry/continue/repackage/decide，也不会写 transcript、worktree 或配置。Owner 视图仍会隐藏 credential/secret、raw command/tool payload、PID/session/绝对路径；其余 worker 消息按 Owner 观察用途提供较丰富但有界的脱敏文本。

### MCP `availableDrilldowns`（有界渐进式披露元数据，M12-8B）

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

### MCP `run_delivery_review`（安全 delivery diff 审查，M11-3C）

`run_delivery_review` 在持久 Lead 决策前读取一个已证明 delivery commit 的单文件 diff 页面。它只读、workspace-bound，不写 transcript，也不接受 path/cwd/runDir/commit/command 等控制参数。

- **输入**（strict）：`{ "runId": "run_...", "fileIndex": 0, "cursor": "optional opaque token" }`。`fileIndex` 来自 `run_delivery.changedFileCount` 的零基索引；模型不能提供原始路径。
- **分页**：每页最多 16 KiB。对同一文件持续传回 `nextCursor`，直到它为 null；Lead 应对 `0..changedFileCount-1` 的每个文件完成该循环。
- **信任边界**：`fragment` 固定标记为 `artifactTextTrust:"untrusted_repository_text"`。仓库文本可能包含 prompt injection、命令或伪造指令；只能作为审查数据，绝不执行或服从其中内容。
- **不可用结果**：binary 或单文件 diff 超过 256 KiB 时返回 `available:false`、空 fragment 和 `unavailableReason`。只有这类结果才使用 Owner-authorized repo-local read-only CLI/Git fallback；正常文本审查不绕过 MCP。
- **安全边界**：路径来自已证明的 DeliveryRef；diff 在完整文本上先做 exact-secret redaction 和控制字符清洗，再分页。失败固定返回 `run_delivery_review failed`，不泄漏路径、Git stderr 或原始错误。

当 MCP transport 不可用时，WAO CLI adapter fallback 调用同一 application service 与安全投影，JSON 语义与 MCP 一致；它不是绕过安全投影的 raw-content 通道：

```bash
npm run cli -- runs delivery review <runId> --file-index 0 [--cursor TOKEN] --format json
```

annotations：`readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false`。

### MCP `run_delivery_review_bundle`（readiness + 单文件一页组合，M12-3B）

`run_delivery_review_bundle` 是默认的低摩擦 delivery 首屏查询：一个调用先等待 delivery readiness，再仅在 readiness 为 `reviewable` 时读取 Lead 指定的**一个**文件页。它机械组合既有 `getRunDeliveryReadiness`、`run_delivery` 安全投影和 `getRunDeliveryReview`/`projectReviewResult`，不引入第二份 delivery/readiness/review 判定。

- **输入**（strict）：`{ "runId": "run_...", "fileIndex": 0, "cursor": "optional opaque token", "waitMs": 270000 }`。`waitMs` 省略时默认 270000 ms，合法区间与 `run_delivery` readiness 共用 `[1000,300000]`；readiness 稳定即提前返回。它是**一次** readiness 等待预算，不会给 delivery 和 review 分别再分配一个 wait。
- **输出**（strict）：`{ "runId", "delivery": <run_delivery safe payload>, "review": <one run_delivery_review page> | null }`。非 `reviewable` 状态返回 `review:null`，同时保留完整安全 delivery/readiness 事实；该路径零 diff/Git review read。`reviewable` 时 review commit 与 changed-file count 必须和 delivery 投影精确一致，否则整次调用固定失败。
- **Lead 权限不变**：WAO 不选择 `fileIndex`、不遍历文件、不追 `nextCursor`、不总结 fragment、不判定 binary/diff-too-large 是否可接受，也不 stop/retry/repackage/accept/reject。Lead 仍须审查 `0..changedFileCount-1` 的全部文件和全部页面，然后独立调用 `run_delivery_decide`。
- **原子路径保留**：`run_delivery` 继续提供 point-in-time/readiness-only 查询；`run_delivery_review` 继续提供单独或 continuation-page 读取。长 worker、人工轮询、故障排查和非标准流程不受组合工具限制。
- **安全边界**：workspace/runId-bound；非 reviewable 时携带 cursor 会 fail-closed，而不是静默忽略；任何服务异常、malformed output 或跨 artifact 拼接固定返回 `run_delivery_review_bundle failed`，无 partial structured output、动态错误、路径或 secret 泄漏。

annotations：`readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false`。

### MCP `run_delivery_reverify`（audited 未变工件重验证，M12-6）

`run_delivery_reverify` 是 Lead 声明的一次性**审计式重验证**：仅当原始终态 verification **failed** 且 Lead 已判断为闭集环境/工具原因（`tooling_invalid` / `environment_contaminated` / `dependency_setup_missing`）时，对**同一个未变 delivery commit** 重跑验证。它委托共享 application service `runDeliveryReverify.js`（与 CLI fallback 同一份），**不调用 model、不 resume worker、不解析 transcript**。原始 assertion 命令**逐字节重跑且不可修改**；Lead 只能追加新的 setup 命令。任何 reverify 都**不自动 accept/reject**——decision 仍只由 Lead 经 `run_delivery_decide` 作出。

- **输入**（strict）：`{ "runId": "run_...", "reason": "tooling_invalid"|"environment_contaminated"|"dependency_setup_missing", "setupCommands": ["npm ci", ...], "timeoutMs": 300000 }`。`setupCommands` 可选（每条非空、上限 32 条、每条 ≤512 字符，常量与 service 同源）；`timeoutMs` 可选（整数，与 M12-13 `verificationTimeoutMs` 共享闭界 `[1000,7200000]`，zod 边界与 service 常量同源）——省略时**继承**该 delivery ref 上持久化的执行预算，ref 无持久值才用 service 默认 300000；持久值缺失/损坏/越界 fail-closed 拒绝（不自动回退默认值）。模型不能传 runDir/cwd/命令覆盖/force 等控制参数。
- **eligible failure**：原 verification 的失败 code 必须是环境/工具闭集（`command_failed`/`command_timeout`/`execution_error`/`setup_failed`/`setup_timeout`/`setup_environment_error`）；内容完整性失败（`artifact_mutated`/`artifact_mismatch`）**不可** reverify。已有 Lead decision 或 reverify 链损坏一律 fail-closed。
- **幂等/并发**：reentrant + crash-safe——重试/并发收敛到**首个调用者**记录的 setup 与同一个 commit，最多一条 durable outcome（`run.delivery_reverification_requested` → `run.delivery_reverification_outcome`）。原始终态 verification **不被改写**。
- **原 vs effective verification**：`run_delivery` 投影同时保留 `originalVerificationStatus`（durable 原始 outcome）与 `effectiveVerificationStatus`（reverify 结果，含 `reverify: {status, reason}` 链事实）；只有完整 reverify 链（requested + outcome）存在时 effective 才可取，非完整链（none/pending/malformed）**不允许**改变 effective 状态（fail-closed）。
- **安全输出**（不返回 commands/worktree 路径/stderr/reason/env/raw events）：

```json
{ "runId": "run_...", "deliveryCommit": "ddd...", "state": "created"|"resumed"|"idempotent", "reason": "tooling_invalid", "verificationStatus": "passed"|"failed"|"unavailable", "failureCode": "command_timeout"|null, "requested": true, "outcomeRecorded": true }
```

Lead 仍须在 decision 前完整 review（`run_delivery_review` / `run_delivery_review_bundle`）并独立决定；reverify passed 不构成 acceptance，reverify failed 也不自动 reject。失败返回固定 `run_delivery_reverify failed`，无 partial structured output、路径或 secret 泄漏。

当 MCP transport 不可用时，WAO CLI adapter fallback 调用同一 application service 与安全输出投影，JSON 语义与 MCP 一致；它不是绕过安全投影的 raw 通道，也不提供 assertion-command override：

```bash
npm run cli -- runs delivery reverify <runId> --reason tooling_invalid [--setup-commands-file FILE] [--timeout-ms N] [--run-dir DIR] [--cwd DIR] [--format json]
```

`--setup-commands-file` 是 UTF-8 JSON string array（缺失 = 空数组；拒绝非数组/非字符串/空白/超界，边界常量与 service 同源）；`--timeout-ms` 缺失由 service 解析（继承 ref 持久预算，否则默认 300000），提供时必须为共享闭界 `[1000,7200000]`（与 M12-13 `verificationTimeoutMs` 同源）内严格整数；`authorizedWorkspaceRoot` 由 CLI 既有 cwd/workspace proof 路径产生，调用方输入不能绕过 workspace ownership。

annotations：`readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false`。

### MCP `run_delivery_decide`（持久 Lead 决策，M9-6B）

`run_delivery_decide` 让 MCP host 记录一个 Lead 决策（accept/reject）。**不可逆**（首决策 wins，后续 lose）。调用共享 service 委托 `tryAppendDecision` 的锁内原子 first-decision-wins 语义。

- **输入**（strict）：`{ "runId": "run_...", "decision": "accepted"|"rejected", "reason": "≤2000 chars" }`。拒绝 runDir/force/merge/push/raw/includeReason 等控制面参数。
- **安全输出**（不返回 reason/DeliveryRef）：

```json
// 赢家
{ "runId": "run_...", "decisionAccepted": true, "deliveryCommit": "ddd...", "acceptanceStatus": "accepted", "existingStatus": null }
// 输家
{ "runId": "run_...", "decisionAccepted": false, "deliveryCommit": "ddd...", "acceptanceStatus": "accepted", "existingStatus": "accepted" }
```

**expected policy rejection 是正常结构化结果，不是错误**：已存在决策（first-decision-wins 的 loser）或其它 durable 策略拒绝（verification/终态/reject-gate/durable facts 冲突）返回 `decisionAccepted:false` + 闭集 `rejectionReason`（如 `already_decided`）——这是结构化 outcome，消费方按正常结果处理，不视为 tool failure。只有 unexpected/internal 异常（非策略拒绝）才返回固定 `run_delivery_decide failed`，无 partial structured output。Reason 在持久化前 trim+redact，但**绝不返回**给 MCP。

annotations：`readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false`（首决策不可逆；重复决策幂等返回 loser）。

### MCP `run_delivery_repackage`（model-free 重打包，M12-1S2）

`run_delivery_repackage` 由 Lead 对 `run_delivery` 已投影的 `candidateKind:"disallowed_scope"|"backend_failed"` 候选传入 `{ runId, allowedPaths }` 重打包。它**复用**该 run 原始持久化的 worktree / base / verification 配置：不调用 model、不 resume worker、不推断 path、不修改 verification 命令、不自动 accept/reject。`candidateInventory.originalAllowedPaths` 给出新合同必须保留的旧批准范围；Lead 审查实际与越界路径后，独立提交最终 `allowedPaths`，它是**唯一**新 scope 权威，并且必须包含全部原始路径且覆盖**所有**实际变更路径。重打包重新计算完整候选清单；read-fail/truncate/empty 一律拒绝。WAO 不合并清单、不判断修改是否合理。原始 `verificationCommands`/`unavailableReason` 按 `run.started` 原值复用，不接受 caller 覆盖。

- **输入**（strict）：`{ "runId": "run_...", "allowedPaths": ["src", "root.txt"] }`。
- **可重入/崩溃恢复/并发安全**：相同输入的并发或重试 → 恰好一条 `run.delivery_created` 与恰好一个最终 verification 结果；不同 allowedPaths 的竞争请求不会互相覆盖。打包在 transcript append 锁外进行（长操作不持锁）；只有短读/校验/CAS-append 在锁内。包装移动了分支但 transcript append 失败/崩溃时，下次同名调用从 Git 精确对象恢复**同一个** commit（严格证明 parent/count/files/message/identity/branch/clean 后才落盘，不丢结果、不重调 model）。
- **安全输出**（不返回 worktreePath/commands/stderr/reason）：

```json
{ "runId": "run_...", "deliveryCommit": "ddd...", "verificationStatus": "passed"|"failed"|"unavailable", "source": "packaged"|"recovered", "recoveryKind": "disallowed_scope"|"backend_failed", "created": true }
```

追加一条 recovery provenance（`run.delivery_repackaged`），绑定 DeliveryRef / 请求 runId / 已批准 scope / `recoveryKind`。原始终态 failed **不被改写**为 completed；但当且仅当 durable recovery facts、provenance、唯一 DeliveryRef 与 verification chain 一致且 verification=passed 时，`run_delivery_decide(accepted)` 可被 Lead 显式接受（仍由 Lead 决定，非自动）。verification failed/unavailable 仍可供 Lead review/reject，绝不自动 reject。

失败返回固定 `run_delivery_repackage failed`。`run_delivery`（结果查询）与 `run_delivery_review` 仍是结果查询/审查 SSOT。

annotations：`readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false`。

### MCP `run_stop`（stop runaway worker，M10 P0-2）

`run_stop` 让 MCP host 停止一个失控的 worker run。它直接复用与 CLI `stop` 相同的 application service（`runStop.js`），不 shell-out CLI。**destructive，workspace-bound**——只允许停止 host-authorized workspace 绑定范围内的 run。

`run_stop` tool：

- **输入**（strict schema，拒绝额外字段）：

```json
{ "runId": "run_..." }
```

模型**不能**传 `runDir`、`force`、registry、timeout 或其它控制参数——这些是 server-owned 配置。

- **安全输出**（只返回机器标识 + 终态事实，不含路径/PID/session）：

```json
{
  "runId": "run_...",
  "terminalAccepted": true,
  "terminalState": "aborted",
  "sideEffectAttempted": true,
  "stopVerified": true
}
```

`terminalAccepted`（first-terminal-wins 仲裁是否认领 `aborted`）、`terminalState`（终态）、`sideEffectAttempted`（是否执行了 taskkill/abort 等破坏性副作用——rejected loser 为 false）、`stopVerified`（进程式 worker 已退出，或 OpenCode session 已由 status + token/message 稳定性确认静默）。OpenCode 观察面不可读时返回 unverified，不能把网络/endpoint 失败当作已停止；观察到 session 仍 active 时也只报告并告警，WAO 不自动执行会杀死其他 session 的全局 `taskkill /IM opencode.exe`。**绝不返回**：PID、进程路径、session id、argv、command、绝对路径、prompt、环境变量或异常 message/stack。失败返回固定安全文案 `run_stop failed`。

**安全契约**：workspace-bound——run 必须属于当前 host-authorized workspace，否则拒绝。不返回 PID/path/session 等可被用于跨 workspace 探测的标识。stop verification 以后置 PID 存活检查为准，不假验证（ESRCH=已退出，EPERM/未知=保守 alive）。

CLI fallback：`npm run cli -- stop <runId>`。

annotations：`readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:true`（认领终态 + process backend 可能 taskkill 自有 PID 树 / OpenCode 可能 abort 指定 session；重复调用幂等返回 loser 但首次破坏性）。

### MCP `runs_list`（project-bound run 列表，M10 P0-3）

`runs_list` 让 MCP host 列出当前 host-authorized workspace 绑定范围内的 run（project-bound recovery）。只读、幂等——不修改任何持久状态、不追加 transcript event。

`runs_list` tool：

- **输入**（strict schema，拒绝额外字段）：

```json
{ "activeOnly": false, "limit": 50 }
```

两个字段均可选。`activeOnly`（bool，默认 `false`）：只返回**经证明 active** 的 run——即 transcript 为已知非终态**且**有 fresh owner heartbeat（`ownerLiveness` SSOT，默认 10s 阈值）。注意（M12-15）：单纯"未到终态"**不足以**算 active；一个非终态但缺少 fresh heartbeat 的 run 不在 `activeOnly` 结果里，但也**绝不**据此推断它 failed/dead/stopped（仍可能长时间运行/休眠），它计入 `unresolvedCount` 并仍出现在普通（非 `activeOnly`）列表中。`limit`（整数 1..100，默认 `50`）：返回条目数上限。模型**不能**传 `runDir`、registry、`agentId`、`cwd`、`workspaceRoot` 等 server-owned 配置——workspace 绑定由 server 解析，不能通过 tool argument 提供。

- **安全有界输出**（只返回机器字段 + 终态/活动事实，不含路径/session/prompt）：

```json
{
  "runs": [
    { "runId": "run_...", "agentId": "coder_low", "state": "running", "terminal": false, "updatedAt": "2026-07-15T00:00:10.000Z", "activityStatus": "active", "activityBasis": "fresh_owner_heartbeat" }
  ],
  "returnedCount": 1,
  "truncated": false,
  "unresolvedCount": 0
}
```

`runs` 每个元素含 `runId`/`agentId`/`state`/`terminal`/`updatedAt` 以及 M12-15 的闭环活动投影字段：

- `activityStatus` ∈ `terminal` | `active` | `unresolved` | `unknown`
- `activityBasis` ∈ `terminal_state` | `fresh_owner_heartbeat` | `no_fresh_owner_heartbeat` | `unknown_state`

`active` 要求已知非终态 + fresh owner heartbeat；`unresolved` = 非终态但无 fresh heartbeat（**绝不**等同于 failed/dead/stopped）；终态与无法识别的 state 永不为 `active`。`returnedCount` = `runs.length`；`truncated` 表示因 `limit` 截断而仍有更多匹配 run；`unresolvedCount` = 全量扫描中已知非终态但缺 fresh heartbeat 的 run 数（受 `limit` 之前、与 `activeOnly` 无关），供 `lead_preflight` 复用而无需重新扫描。**绝不返回**：PID、进程路径、session id、argv、command、绝对路径、prompt、环境变量、messages、evidence 或异常 message/stack。失败返回固定安全文案 `runs_list failed`。

一次 `runs_list` / `lead_preflight` 查询会先证明授权 workspace，再按查询范围缓存每个不同 ownership cwd 的 Git 顶层证明（包括 fail-closed 的不可证明结果）；不会为同一项目的每个历史 run 重复启动 Git 证明进程。缓存只活在单次查询内，不跨调用持久化，也不改变 workspace 隔离、过滤或错误投影。

**Workspace-bound**：只返回当前 host-authorized workspace 绑定范围内的 run——其它项目的 run 不可见（project-bound recovery，不跨 workspace 探测）。workspace 未绑定时返回空 `runs:[]`（不 fail-closed，因这是只读列举而非 state-changing）。

CLI fallback：`npm run cli -- runs list [--agent ID] [--latest N]`。

annotations：`readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false`（纯只读列举查询）。

### MCP `run_wait`（long-poll 终态/活性等待，M10-pre3）

`run_wait` 让 MCP host 以 long-poll 方式等待一个 run 到达终态或产出 liveness 摘要，避免 busy `run_status` 轮询。它直接复用与 CLI 同等的 application service（`runWait.js`，读 transcript + owner 心跳 freshness SSOT `ownerLiveness.js`），不 shell-out CLI。**只读**——不追加 transcript event、不修改 terminal state、不改变 run 生命周期。

`run_wait` tool：

- **输入**（strict schema，拒绝额外字段）：

```json
{ "runId": "run_...", "afterSeq": 42, "waitMs": 270000 }
```

`runId` 必填。`afterSeq`（整数 ≥0，可选）：

- **省略**：service 把首次读取 transcript 时的最大 `seq` 作为基线——只统计等待窗口内出现的新进展，不把历史事件误报为 progress（这是首轮 poll 的默认行为）。
- **显式 `0` 或正整数**：调用者有意统计 `seq > afterSeq` 的全部进展（含历史），用于续读。把上次返回的 `cursor` 当 `afterSeq` 传回即可增量续读。

`waitMs`（整数，**下限 180000** 即 180s，**默认 270000 即 4.5 分钟**，上限 600000）：Lead 的单次观察窗口。`waitMs:0` 在这里有意无效；point-in-time 读取使用 `run_await_result({waitMs:0})` 或 `run_status`。窗口到期只返回 liveness，**不表示 worker 失败，也不会中止 worker**。模型不能传 `runDir`、registry、`force`、timeout 控制面参数——这些是 server-owned 配置。

- **返回时机**：服务在两种情况下返回——(1) run 到达终态（completed/failed/aborted/timed_out），此时 `returnedEarly:true`；(2) `waitMs` 到期仍未终态，此时 `returnedEarly:false` 并附带 liveness 摘要让 Lead 决定下一步。**普通新事件不会触发提前返回**——只有终态会；窗口内的新进展通过到期的 liveness=`progress` 体现。
- 若返回 `terminal:true`，该终态事实已足够，Lead 直接进入 `run_collect`；除恢复、独立复核或没有 wait 结果外，不需要再调用一次 `run_status`。

- **安全有界输出**（只返回机器字段 + liveness 摘要，不含内容/路径/session）：

```json
{
  "runId": "run_...",
  "state": "running",
  "terminal": false,
  "cursor": 42,
  "returnedEarly": false,
  "observationOutcome": "observed",
  "readFailureReason": null,
  "liveness": "progress",
  "activityEventCount": 3,
  "lastActivityKind": "command",
  "ownerHeartbeat": "fresh",
  "observation": {
    "outcome": "window_expired",
    "waitedMs": 270000,
    "windowMs": 270000
  },
  "termination": null
}
```

字段：

- `state`：从 transcript 投影的当前状态（含 `unknown`）。
- `terminal`：是否已到终态。
- `cursor`：返回时已观测到的最大 `seq`，作为下次 `afterSeq` 的续读点（读失败时为 `null`）。
- `returnedEarly`：`true` = 因终态提前返回；`false` = `waitMs` 到期返回。
- `observationOutcome`（M12-11）：闭集 `observed` / `read_failure`。`read_failure` 表示 snapshot 无法读取/不可信——**fail-closed**：不把陈旧事件 liveness 与新鲜 owner 心跳拼成"看似当前"的观测。
- `readFailureReason`：仅 `observationOutcome==="read_failure"` 时为闭集机器码（`transcript_parse_failed`/`legacy_event_shape`/`snapshot_unavailable`），否则 `null`；绝不带 error message/path/command/credential。
- `liveness`（见下；读失败时为 `unknown`）。
- `activityEventCount`：相对 baseline 的证据事件数（读失败时为 `null`）。
- `lastActivityKind`：最近一条证据事件的闭合安全标签（`message`/`thinking`/`command`/`tool_use`/`tool_result`/`file_written`/`runtime_status`/`metrics`/`state`/`delivery`/`scorecard` 等）；不存在为 `null`。
- `ownerHeartbeat`：owner 心跳新鲜度投影，枚举 `"fresh"`（.owner 文件存在且心跳在阈值内）/`"stale"`（存在但过时）/`"n/a"`（终态返回，无 owner 概念）/`"unknown"`（读失败，不查心跳）。**是字符串枚举，不是对象**。
- `observation`（M12-11，附加闭集事实）：`{ outcome, waitedMs, windowMs }`。`outcome ∈ { point_in_time, window_expired, terminal, read_failure }` 清楚区分"窗口到期"与"终态"与"读失败"——一个到期的观察窗口**绝不意味着 worker 已停止**。
- `termination`（M12-11，附加闭集事实）：`null`（非终态/读失败/窗口到期），或 `{ state, source, configuredMs, policySource }`——**仅在干净观测到终态时非空**。`source ∈ { completion, execution_deadline, manual, provider, backend, control_plane, unknown }` 说明**谁/什么**导致终态：`execution_deadline` 仅当 WAO 的 wall-clock 截止定时器真的触发（有 bound `run.timed_out` 事实）——没有该事实的 `timed_out` 态降级为 `unknown`，Lead 绝不会误判 WAO 停了 worker。`configuredMs`/`policySource` 来自绑定的 `run.wait_policy` 事实（缺失/冲突/畸形 → `null`/`unknown`，**缺失绝不等于 disabled**）。

`liveness` 取值（从 transcript 事件流 + owner 心跳投影，**不引 isAlive**）：

- `terminal` —— run 已到终态（completed/failed/aborted/timed_out）。
- `progress` —— baseline 之后有证据事件（message/command/tool_use/tool_result/file_written/payload-free runtime status/`run.metrics`），worker 在产出。
- `process_only` —— baseline 之后无证据事件，但 owner 心跳新鲜（worker 进程仍在，疑似思考或卡顿）。
- `silent` —— baseline 之后无证据事件，且 owner 心跳过时或不存在（排队或疑似卡住）。

注意：`run.metrics`（token/cost tick）算作进展，但其原始 token/cost 数值**绝不返回**——只暴露 `lastActivityKind:"metrics"`。证据事件的闭集由 `runWait.js` 所有；`ownerLiveness.js` 只负责心跳新鲜度 SSOT，不是完整 liveness 投影 SSOT。

**绝不返回**：原始 event payload、command/tool input/message/reason/error 内容、绝对路径、PID、prompt、argv、环境变量、token/cost 原值。**M11-8B**：返回 `agentId`——transcript envelope 盖戳的 canonical worker 身份（不从 worker 自由文本推断；缺失/冲突降级为 `"unknown"`，不抛错、不伪造身份、不是自动停止门）。**M12-8E**：返回静态有界 `availableDrilldowns`，让 Lead 在需要时下钻 `run_activity`/`run_diagnose`/`run_collect`；它不包含 worker 动态文本，不自动调用工具或停止 run。`content` JSON 与 `structuredContent` 语义一致。service 失败时返回固定安全文案 `run_wait failed`，不泄漏 zod 校验信息。

**transport keepalive（M10-pre3 closeout）**：MCP SDK 的请求超时可能短于 `run_wait` 的 270s 默认观察窗口。为避免 client 在 server 仍正常观察时超时，server 在每次 poll 后向请求关联的 `progressToken` 发送标准 `notifications/progress`（仅当 client 通过 `onprogress` 请求了进度时）。client 若设 `resetTimeoutOnProgress:true`，每收到一条进度就重置自身计时器。这是标准 MCP 机制，不 patch host、不改全局 timeout；client 的最大总超时仍由 host 自己决定。若 host 不请求进度，server 不发通知，client 仍受其超时约束。

**transport 恢复契约（M12-11，Host-neutral）**：`run_wait` / `run_await_result` 都是只读 advisory 工具。若一次调用**没有返回结果**（transport drop/超时被 host 中断），观察状态是 **unknown**——这两个工具**没有做任何 control-plane 变更**，也没有停止 worker。恢复方式是 point-in-time 重读：再调一次 `run_await_result(waitMs:0)` 或 `run_status`。**绝不能从 transport 丢失推断 worker 是 alive 还是 dead**；只有干净观测到的终态（`termination` 非空、`observation.outcome==="terminal"`）才陈述终止事实，且终止来源是闭集 `termination.source`，不是从 transport 状态猜测。

**三钟分离（M10-pre3）**：WAO 现在有三个互相独立的时钟，不要混淆：

1. **执行截止（execution deadline，默认禁用）**：worker run 上的 wall-clock 终止时钟。M10-pre3 起**默认禁用**——不再用 wall-clock 杀 worker，改由 Lead 观察驱动。显式配置时仍生效。
2. **后端请求超时（backend request timeout，独立）**：单次后端调用（HTTP/进程 spawn/collect 拉取）的网络/IO 超时，与 run 生命周期正交，按 `config.timeout` 链生效。
3. **Lead 观察等待（`run_wait`）**：Lead 侧的 long-poll 阻塞上限（`waitMs`，默认 270s、下限 180s），只决定 Lead 一次调用等多久，**不影响 worker 生命周期**。到时返回当前 liveness 让 Lead 决定继续等/collect/stop。

CLI fallback：`run_wait` 是 MCP-first 能力，等价的 CLI 长等待可由 `status` 轮询或 `tail --follow` 拼出，但语义不等同。

annotations：`readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false`（纯只读 long-poll，不触碰外部系统、不修改 transcript）。

---

### MCP resources `wao://playbooks`（可选只读 Lead Playbook Catalog，M11-2 / M12-10）

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

### MCP `semanticNotes` + resources `wao://semantics`（Self-Describing Results，M12-12）

恰好四个 standalone 只读成功结果——`run_wait`/`run_await_result`/`run_delivery`/`run_diagnose`——携带 REQUIRED `semanticNotes`（1..4 条）。每条恰好三键 `{ id, meaning, doesNotMean }`：`id` 是冻结的 namespaced 闭集值（`observation.*`/`termination.*`/`delivery.*`/`diagnosis.*`），`meaning` 是一句确定性事实，`doesNotMean` 是 0..2 条确定性非含义。**没有** `scope` 字段、**没有** per-entry `semanticsRef`；详情 URI 机械派生 `wao://semantics/{id}`。

notes 完全由既有机器事实决定（M12-11 observation outcome / termination source、diagnosis category、delivery readiness / verification status），由单一纯 SSOT `src/application/runSemanticsNotes.js` 选择——**永不**回显 transcript/provider/path/prompt/command/session，**永不**建议 accept/reject/repackage/stop/retry/dispatch。关键不变量：`observation.read_failure` **不**产生任何终止 note；delivery note 明确 verification passed **不是** Lead acceptance；diagnosis note 只陈述事实、不给处方。`run_delivery_review_bundle` 嵌入的 nested delivery BASE **不含** `semanticNotes`。

两个只读 resources（`resources/read`，mimeType `application/json`）：

```
wao://semantics            → { semantics: [{ id, meaning }] }                 // summary：每个 id + meaning（无 doesNotMean）
wao://semantics/{id}       → { note: { id, meaning, doesNotMean } }           // 详情：单条完整 note
```

`resources/list` 返回 summary resource（`wao://semantics`）；`resources/templates/list` 返回 `wao://semantics/{id}` 模板。**不**把每个 detail id 注册为独立静态 resource。读取委托同一 `runSemanticsNotes.js` SSOT。未知/畸形 id 与 service 失败折叠为**固定安全文本**（`semantics summary failed`（summary）/ `semantics detail failed`（detail，含未知 id）），不回显请求 id 或目录原始内容——唯一例外是协议要求回显 caller 提供的 `uri`。

---

## 五、常见问题

### claude 报 `stream-json requires --verbose`
已内置处理（buildArgs 自动加 `--verbose`）。

### codex 报 git repo check
已内置处理（buildArgs 自动加 `--skip-git-repo-check`）。

### worktree 清理失败（Permission denied）
Windows 文件锁问题。已内置 fallback（rmSync + git worktree prune）。若仍有残留：
```powershell
git worktree prune
git worktree remove --force .wao-worktrees/<runId>
```

### opencode serve 端口不对
smoke 脚本自动探测 4297-4299。手动指定时改 `config/agents.json` 里的 `serveUrl`。

### worker 报 401（"身份验证失败"）但 opencode TUI 正常
根因：opencode serve 进程没继承 provider key（`ZHIPU_API_KEY`/`KIMI_API_KEY`）。TUI 从你的终端继承 env 所以正常，后台 serve 不一定。
解决：**用 `scripts/serve.ps1` 启动 serve**——它从 User registry 读 key 注入。WAO 现在会在 provider 401 时立即 `done(failed)`（不再卡超时），但 key 仍必须存在。

### 多行 prompt 被截断（只传了第一行）
PowerShell 原生参数解析会把多行字符串截断。**多行任务必须用 `--prompt-file <path>`**（从文件读，完整传递），不要用 `--prompt "多行..."`。

### 后台 run 在 CLI 进程退出后存活？
M3 阶段：`spawn` 不带 `--wait` 时，run 依赖 opencode serve（HTTP 类会继续）或进程式子进程。进程式在 CLI 退出后会被 SIGINT 杀掉。真正的后台存活需要 M7 daemon 形态。
