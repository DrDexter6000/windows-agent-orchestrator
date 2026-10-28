# 安装与配置

> [使用手册](../usage.md)的一页：第一次安装 WAO、写配置、验证安装。

## 前置要求

| 依赖 | 版本 | 检查命令 |
|------|------|---------|
| Node.js | v22（硬约束：守卫只放行 v22，其余版本拒绝，见下） | `node --version` |
| git | 任意（worktree 隔离需要） | `git --version` |

### Node 为什么必须 v22

WAO 进程式 backend（claude-code / codex / kimi-code / zcode / deepseek-harness / deepseek-acp）的"进程死即会话死"隔离，依赖 Node 自 v18+ 内置的 Windows Job Object：父进程退出，OS 自动杀掉全部子进程树。Node v24 上这个内置机制回归（会误杀长进程），v23 非 LTS，其余 major 未经认证，所以守卫只放行 v22。cli / daemon / background-runner 入口在启动时硬拒绝 v22 以外的一切版本（`help` / `version` 例外），并指引切 v22。为什么见决定 0013。

- v24 上启动会看到 `WAO 拒绝启动：Node v24.x 被拒绝：v24 has a libuv Windows Job Object regression ... 请用 v22`，exit 1。
- `npm test`、`npm run cli` 等 npm scripts 经 `scripts/wao-node.cjs` 启动器自动选 v22：先看 env `WAO_NODE`，再找共享安装 `%LOCALAPPDATA%\Programs\nodejs-v22\node.exe`，最后探测 PATH 上的 node 并经守卫判定。开发 WAO 时怎么跑测试见 `docs/testing.md`。

### 如何装 / 切到 v22

仓库根 `.nvmrc` 声明 `22`。用任意版本管理器（nvm-windows、fnm）或直接装 v22 LTS 都行，按 `.nvmrc` 切到 v22 即可——装法本身是这些工具自己的文档，本页不重抄。

## 可选的 agent runtime（按需装，不装也能用其它 backend）

| runtime | 安装 | 用途 |
|---------|------|------|
| opencode | `npm install -g opencode-ai` | HTTP 类 backend（需先 `opencode serve`）；也可作为 MCP Lead host（见[接入宿主与绑定项目](host.md)的 OpenCode 项目级配置） |
| claude code | 见 [anthropic 官方](https://docs.anthropic.com/en/docs/claude-code) | 进程式 backend（需登录：`claude login`） |
| codex | `npm i -g @openai/codex` | 进程式 backend（需登录：`codex login`） |
| kimi code | 见 [kimi-cli 官方](https://platform.moonshot.cn/) | 进程式 backend，多模态（需过 Kimi 白名单，无需登录命令）。暂停使用：kimi 车道走 kimi-web；本后端不支持在途纠偏、不上报 token 用量 |
| DeepSeek Harness | 见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 暂停使用，由下一行的 ACP 面接替。实验性 stdio JSON-RPC backend；需自行准备 dedicated `dsh-jsonrpc-agent` composition 与 `DEEPSEEK_API_KEY`，WAO 不安装或修复 runtime |
| DeepSeek Harness（ACP 面） | `dsh` CLI ≥ 0.1.5-rc（见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)） | `deepseek-acp` backend：`dsh --profile acp` + 操作员安装的 containment 覆盖层 + `DEEPSEEK_API_KEY`；WAO 只 detect / invoke / report。安装步骤与限制见 `docs/certification-runbook.md`「DSH 通道适用限制与能力交叉警告」 |

kimi-code 与 DSH stdio 面为何暂停，见决定 0074。

你不需要全装，装一个就能用。不同 agent 可以用不同 backend。

claude-code 车道（native OAuth 通道）的 worker 会话运行于临时隔离配置目录：用户日常 `~/.claude` 的技能/插件/设置对 WAO 派发的会话不可见（设计行为，含 `--add-dir` 逃生门）。见 `docs/troubleshooting.md` §7.13。

### Provider key（claude-code wrapper / opencode serve 需要）

claude-code 经 wrapper 调非 Claude provider（GLM/DeepSeek）时，wrapper 读 env 里的 key；opencode serve 也需 provider key。按你用的 provider 配：`ZHIPU_API_KEY` / `DEEPSEEK_API_KEY` / `KIMI_API_KEY`。key 的验证、注入与 401 排错见 `docs/troubleshooting.md` §1.2（用 `scripts/serve.ps1` 启动 serve 会从 User registry 读 key 注入）。`npm run cli -- wao doctor` 按 registry 里 worker 声明的 env 名查 key：进程 env 命中为 OK；仅在 Windows User 作用域命中为 INFO（派发时由凭据桥从 User 作用域注入，不必为 WAO 重启终端）；都没有为 FAIL（附 setx 修复提示）。

## 安装本工具

```powershell
git clone <repo> D:\projects\windows-agent-orchestrator
cd D:\projects\windows-agent-orchestrator
# WAO 含 MCP SDK/zod 依赖，clone 后必须安装：
npm ci
```

在 WAO 开发仓库内执行一次 `npm link`，即可在任何目录使用全局 `wao` 命令（它总是执行当前链接的这份 checkout）：

```powershell
cd D:\projects\windows-agent-orchestrator
npm link
```

此后可以从任意目录用全局 `wao <command>` 代替 `npm run cli -- <command>`（写法见[派发](dispatch.md)），例如 `wao dashboard`（见[维护](maintenance.md)的「Owner 本地只读看板」），不必 `cd` 进 WAO 仓库。

经全局 `wao` 命令调用时，`config/default.json`、run 目录（`runs/`）与 agent registry（`config/`）从受信安装根（`npm link` 链接的这份 checkout）解析，而非当前目录。安装根由 `bin/wao.js` 自身位置（`import.meta.url`）派生，作为子进程 env（`WAO_INSTALL_ROOT`）传给 CLI 子进程：不经 argv、不拼 shell 字符串，并覆盖调用方任何同名值。因此 `--cwd` 仍只决定命令观察/过滤哪个 Git 项目；显式 `--run-dir` / `--registry` 覆盖照原样使用、不被重定位；`npm run cli -- ...`（不带该 env）保持从当前目录解析。

## 配置

1. 复制 registry 模板并编辑：
```powershell
Copy-Item config/agents.example.json config/agents.json
```

编辑 `config/agents.json`，按需增删 agent。`cwd` 模板默认是 `.`，解析为发起派发的进程的当前工作目录：CLI 通道是你敲命令时所在的目录，MCP 通道是 MCP 服务进程的 cwd（由宿主决定）；恒存在，开箱即跑。要固定目标项目就改成真实路径（必须已存在），或保持 `.` 由派发时 `--cwd` 覆盖。`wao doctor` 对 cwd 为 `.` 的 worker 出一条 INFO 落点提示，不计 DEGRADED。

> 从全新 clone 只配一个 worker：`npm run cli -- wao onboarding --agent <agentId> --apply` 自动从入库模板生成单 worker registry + host-neutral MCP 片段，零手编。正式验收链见 `AGENT_ONBOARDING.md` §9。
> 已生成 `config/agents.json` 后裸跑 `npm run cli -- wao onboarding`，车道矩阵按双源展示：已配置行（真实状态、私有 registry 顺序）在前，模板未配置候选（行尾 `·模板候选`）在后；同 id 但 backend/model 漂移的行挂 `·drift` 并在表后列有界明细；`--apply` 仅适用模板候选行。还没生成（或不可读）时是纯模板面。

派发选择怎么用认证结果，见 `docs/certification-runbook.md` §认证结果用于派发选择的边界。

2.（可选）编辑 `config/default.json` 调整全局默认值：
```jsonc
{
  "registry": "config/agents.json",
  "runDir": "runs",              // transcript 存放目录
  "pollInterval": 5000,          // opencode 轮询间隔 ms
  "waitTimeout": null,           // 派发侧等待窗 ms；null=禁用。到期只通知不终止——观察预算，非执行死线；设值须在 1000..600000
  "timeout": 30000,              // HTTP 请求超时 ms
  "retries": 2,                  // HTTP 请求重试次数
  "defaultIsolation": "none",    // 默认不隔离（可选 "worktree"）
  "worktreeDir": null            // worktree 存放目录（null = <cwd>/.wao-worktrees）
}
```

## 验证安装

```powershell
# 各命令的作用见 npm run cli -- --help（生成副本：docs/surface/cli.md）
npm run cli -- registry list --registry config/agents.json
npm run cli -- registry check --registry config/agents.json

# 车道一屏参考（只读）
npm run cli -- wao lanes
```

车道怎么配置与维护见[车道配置与维护](lanes.md)。smoke、runtime certification（`npm run reliability`）与 drill 转录维护命令见 `docs/certification-runbook.md` §认证与转录维护命令。
