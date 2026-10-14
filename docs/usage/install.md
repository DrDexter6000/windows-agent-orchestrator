# 安装与配置

> [使用手册](../usage.md)的一页：第一次安装 WAO、写配置、验证安装。

## 前置要求

| 依赖 | 版本 | 检查命令 |
|------|------|---------|
| Node.js | **v22（硬约束，v24 会被拒绝，见下）** | `node --version` |
| git | 任意（worktree 隔离需要） | `git --version` |

### Node 为什么必须 v22（不能 v24）

WAO 进程式 backend（claude-code/codex/kimi-code/deepseek-harness/deepseek-acp）的"进程死即会话死"隔离，依赖 **Node 自 v18+ 内置的 Windows Job Object**（父进程退出→OS 自动杀全部子进程树）。**Node v24 有 libuv Job Object 回归**（会误杀长进程），所以 WAO 在 cli / daemon / background-runner 入口**硬拒绝 v24**并指引切 v22。详见 TD-40 + `.wao/decisions/0013`。

- v24 上启动会看到：`WAO 拒绝启动：Node v24.x 被拒绝：v24 has a libuv Windows Job Object regression ... 请用 v22`，exit 1。
- `npm test` 同样走 v22 shim：入口为 `node scripts/wao-node.cjs scripts/canonical-test.mjs`，canonical runner 读 `test/manifest.json` 把每个 `.test.js` 恰好归入一个资源类别（pure/git/worktree/process/lock/timeout/mcp，用于归属与漂移检测），执行组织成串行波（wave）：同一波池化多个类别共享有界并发、长极重叠（filesystem 波池化 git+worktree，lock 波严格串行），并对首轮失败隔离复核一次（只追加 stable_fail/isolation_pass/environment_invalid 分类，绝不把复核通过洗成 PASS）。测试本身 mock 子进程、不依赖真实进程隔离；子进程注入 `WAO_SKIP_VERSION_GUARD=1` 绕过版本守卫。自 R23-F/A 起 `test-results.json` 的每个文件条目还携带 `durationMs`——该文件内各 test 耗时之和（不含模块 import/钩子间隙）的 advisory 计时元数据（透传结构化 reporter 累计的 suite 时长；报告缺失/损坏或文件 missing/crash 时为 `null`），只作观测、不参与 verdict；隔离复核条目同样携带 `isolationDurationMs`（缺失归一 `null`）。自 R23-F/B 起一次 canonical 全量整体受同机验证串行化闸保护（闸语义见[交付与验收](delivery.md)场景 4b；排队不计入测试预算，`WAO_VERIFICATION_GATE=off` 停用）。

### 如何装 / 切到 v22

仓库根 `.nvmrc` 声明 `22`。任选一种版本管理器（推荐 nvm-windows 或 fnm）：

```powershell
# 方式 A：nvm-windows（winget 装）
winget install CoreyButler.NVMforWindows
nvm install 22        # 装项目声明的 v22
nvm use 22
cd D:\projects\windows-agent-orchestrator   # nvm 会读 .nvmrc 自动切
node --version        # 应 v22.x

# 方式 B：fnm（winget 装）
winget install Schniz.fnm
# 给 PowerShell 加 fnm env（加到 $PROFILE）：fnm env --use-on-cd | Out-String | Invoke-Expression
fnm install 22
fnm use 22
cd D:\projects\windows-agent-orchestrator   # 配 --use-on-cd 会按 .nvmrc 自动切

# 方式 C：不用管理器——直装 v22 LTS 覆盖
# 去 https://nodejs.org 下 v22 .msi 装即可（覆盖现有 node）
```

## 可选的 agent runtime（按需装，不装也能用其它 backend）

| runtime | 安装 | 用途 |
|---------|------|------|
| opencode | `npm install -g opencode-ai` | HTTP 类 backend（需先 `opencode serve`）；也可作为 MCP Lead host（见[接入宿主与绑定项目](host.md)的 OpenCode 项目级配置） |
| claude code | 见 [anthropic 官方](https://docs.anthropic.com/en/docs/claude-code) | 进程式 backend（需登录：`claude login`） |
| codex | `npm i -g @openai/codex` | 进程式 backend（需登录：`codex login`） |
| kimi code | 见 [kimi-cli 官方](https://platform.moonshot.cn/) | 进程式 backend，多模态（需过 Kimi 白名单，无需登录命令）。**暂停使用**（决定 0074）：kimi 车道走 kimi-web；本后端不支持在途纠偏、不上报 token 用量 |
| DeepSeek Harness | 见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | **暂停使用**（TD-117、决定 0074；由下一行的 ACP 面接替）。实验性 stdio JSON-RPC backend；需用户自行准备 dedicated `dsh-jsonrpc-agent` composition 与 `DEEPSEEK_API_KEY`，WAO 不安装或修复 runtime |
| DeepSeek Harness（ACP 面） | `dsh` CLI ≥ 0.1.5-rc（见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)） | `deepseek-acp` backend（ADR-0031）：`dsh --profile acp` + 操作员安装的 containment 覆盖层 + `DEEPSEEK_API_KEY`；WAO 只 detect / invoke / report（安装步骤见 `docs/certification-runbook.md`「DSH 通道适用限制与能力交叉警告」） |

**你不需要全装。** 装一个就能用。不同 agent 可以用不同 backend。

claude-code 车道（native OAuth 通道）的 worker 会话运行于临时隔离配置目录——用户日常 `~/.claude` 的技能/插件/设置对 WAO 派发的会话**不可见**（设计行为，含 `--add-dir` 逃生门）：见 `docs/troubleshooting.md §7.13`。

### Provider key（claude-code wrapper / opencode serve 需要）

claude-code 经 wrapper 调非 Claude provider（GLM/DeepSeek）时，wrapper 读 env 里的 key；opencode serve 也需 provider key。所需 env：`ZHIPU_API_KEY` / `DEEPSEEK_API_KEY` / `KIMI_API_KEY`（按你用的 provider 配）。**详细的 key 验证 / 注入 / 401 排错见 `docs/troubleshooting.md §1.2`**（用 `scripts/serve.ps1` 启动 serve 会从 User registry 读 key 注入）。`npm run cli -- wao doctor` 按 registry 保留 worker 声明的 env 名查 key（scoped）：进程 env 命中为 OK；仅在 Windows User 作用域命中给 WARN（新开终端可用）；都没有才 FAIL（附 setx 修复提示）。

## 安装本工具

```powershell
git clone <repo> D:\projects\windows-agent-orchestrator
cd D:\projects\windows-agent-orchestrator
# WAO 含 MCP SDK/zod 依赖，clone 后必须安装：
npm ci
```

**一次性开发安装（M12-8F）：** 在 WAO 开发仓库内执行一次 `npm link`，即可在任何目录使用全局 `wao` 命令（它总是执行当前链接的这份 checkout）：

```powershell
cd D:\projects\windows-agent-orchestrator
npm link
```

此后顶层命令可直接运行——如 `wao dashboard`（本启动器，见[维护](maintenance.md)的「Owner 本地只读看板」）——不必 `cd` 进 WAO 仓库，也不用担心 `npm run cli` 从其它目录报 "Missing script: cli"。注意只有顶层命令可用 `wao <command>` 形式；嵌套在命令族下的命令（如 `wao doctor`）仍需 `npm run cli -- wao doctor` 原形式。

**共享状态解析根（M12-8F）：** 经全局 `wao` 命令调用时，WAO 把 `config/default.json`、run 目录（`runs/`）与 agent registry（`config/`）从**受信安装根**（即 `npm link` 链接的这份 checkout）解析，而非当前目录。该安装根由 `bin/wao.js` 自身位置（`import.meta.url`）派生，作为子进程 env（`WAO_INSTALL_ROOT`）传给 CLI 子进程——不经 argv、不拼 shell 字符串，并覆盖调用方任何同名值（受信、不可注入）。因此 `--cwd` 仍只决定命令观察/过滤哪个 Git 项目（如看板按 ownership 过滤的目标 workspace），显式 `--run-dir`/`--registry` 覆盖照原样使用、不被重定位；`npm run cli -- ...`（不设该 env）保持从当前目录解析的遗留行为不变。

## 配置

**1. 复制 registry 模板并编辑：**
```powershell
Copy-Item config/agents.example.json config/agents.json
```

编辑 `config/agents.json`，按需增删 agent。`cwd` 模板默认是 `.`（R8-1：解析为发起派发的进程的当前工作目录——CLI 通道=你敲命令时所在目录；MCP 通道=MCP 服务进程的 cwd，由 host 决定；恒存在，开箱即跑）——要固定目标项目就改成真实路径（必须已存在），或保持 `.` 由派发时 `--cwd` 覆盖（`wao doctor` 对 cwd 为 `.` 的 worker 会出一条 INFO 落点提示，不计 DEGRADED）。

> 第三方从全新 clone 只配一个 worker：`npm run cli -- wao onboarding --agent <agentId> --apply` 自动从入库模板生成单 worker registry + host-neutral MCP 片段（零手编）。正式验收链见 `AGENT_ONBOARDING.md` §9。
> 已生成 `config/agents.json` 后裸跑 `npm run cli -- wao onboarding`，角色矩阵按双源展示（决策 0024）：已配置行（真实状态、私有 registry 顺序）在前，模板未配置候选（行尾 `·模板候选`）在后；同 id 但 backend/model 漂移的行挂 `·drift` 并在表后列有界明细；`--apply` 仅适用模板候选行。还没生成（或不可读）时是纯模板面，输出不变。

**当前派发策略**（认证结果用于派发选择的边界）正文已完整迁移至 `docs/certification-runbook.md` §认证结果用于派发选择的边界（单向链接；唯一权威）。

**2.（可选）编辑 `config/default.json`** 调整全局默认值：
```jsonc
{
  "registry": "config/agents.json",
  "runDir": "runs",              // transcript 存放目录
  "pollInterval": 5000,          // opencode 轮询间隔 ms
  "waitTimeout": 300000,         // 派发侧等待窗 5 分钟（ADR-0030：到期=通知不杀——观察预算，非执行死线）
  "timeout": 30000,              // HTTP 请求超时
  "retries": 2,                  // HTTP 请求重试次数
  "defaultIsolation": "none",    // 默认不隔离（可选 "worktree"）
  "worktreeDir": null,           // worktree 存放目录（null = <cwd>/.wao-worktrees）
  "portRange": [30000, 31000]    // 端口分配范围（M5 用）
}
```

## 验证安装

```powershell
# 列出所有配置的 agent
npm run cli -- registry list --registry config/agents.json

# 检查 opencode serve 是否可达（只对 opencode-serve backend）
npm run cli -- registry check --registry config/agents.json

# 车道一屏参考（0064，只读）：接线轴 + Owner 画像 + 认证简表 + 就绪探测
npm run cli -- wao lanes
```

smoke / runtime certification（`npm run reliability`）/ drill 转录维护命令正文已完整迁移至 `docs/certification-runbook.md` §认证与转录维护命令（单向链接；唯一权威）。
