# 部署与使用指南

> 本文档基于 M0–M8 + fresh-runtime hardening 后的实际能力编写。
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
- `npm test` 不受影响（用 `WAO_SKIP_VERSION_GUARD=1` 在任意 Node 上跑，测试不依赖真实进程隔离）。

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
| opencode | `npm i -g opencode` | HTTP 类 backend（需先 `opencode serve`） |
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
# 无 npm install（零依赖项目）
```

### 配置

**1. 复制 registry 模板并编辑：**
```powershell
Copy-Item config/agents.example.json config/agents.json
```

编辑 `config/agents.json`，把 `cwd` 改成你的项目目录，按需增删 agent。

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
        "baseUrl": "https://open.bigmodel.cn/api/anthropic",
        "apiKeyEnv": "ZHIPU_API_KEY",
        "model": "glm-5-turbo",
        "contextWindow": 128000
      },
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

限制：仅支持 foreground `run`，不支持 `--background` 或 `spawn`。

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
| `run.event` | 证据事件透传（kind: command/file_written/tool_use/tool_result） | M6 |
| `scorecard.checked` | scorecard 门控结果（passed + checks），仅配了 rules 时写 | M6 |
| `run.completed` | 正常完成 | M0 |
| `run.timed_out` | 超时 | M0 |
| `run.aborted` | 被 abort | M0 |
| `run.error` | 错误 | M0 |
| `run.stop_requested` | 用户请求停止 | M0 |
| `messages.collected` | collect 命令拉取消息 | M0 |
| `run.rerun` | 进程式 resume 重放（originalSessionId → newSessionId） | M3 |
| `run.cleanup_done` | worktree 清理完成 | M3 |
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
