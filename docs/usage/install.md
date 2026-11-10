---
read_when: 部署参考：Node v22 约束与切换、可选 runtime 安装、凭据 env 判读、全局 `wao` 安装根、`config/default.json`；从零到可用的步骤在 AGENT_ONBOARDING.md
---
# 安装与配置

> [使用手册](../usage.md)

## 前置要求

| 依赖 | 版本 | 检查命令 |
|------|------|---------|
| Node.js | v22（硬约束：守卫只放行 v22，其余版本拒绝，见下） | `node --version` |
| git | 任意（worktree 隔离需要） | `git --version` |

### Node 为什么必须 v22

WAO 进程式 backend（claude-code / codex / zcode / deepseek-acp）的"进程死即会话死"隔离，依赖 Node 自 v18+ 内置的 Windows Job Object：父进程退出，OS 自动杀掉全部子进程树。Node v24 上这个内置机制回归（会误杀长进程），v23 非 LTS，其余 major 未经认证，所以守卫只放行 v22。cli / daemon / background-runner 入口在启动时硬拒绝 v22 以外的一切版本（`help` / `version` 例外），并指引切 v22。为什么见决定 0013。

- v24 上启动会看到 `WAO 拒绝启动：Node v24.x 被拒绝：v24 has a libuv Windows Job Object regression ... 请用 v22`，exit 1。
- `npm test`、`npm run cli` 等 npm scripts 经 `scripts/wao-node.cjs` 启动器自动选 v22：先看 env `WAO_NODE`，再找共享安装 `%LOCALAPPDATA%\Programs\nodejs-v22\node.exe`，最后探测 PATH 上的 node 并经守卫判定。开发 WAO 时怎么跑测试见 `docs/testing.md`。

### 如何装 / 切到 v22

仓库根 `.nvmrc` 声明 `22`。用任意版本管理器（nvm-windows、fnm）或直接装 v22 LTS 都行，按 `.nvmrc` 切到 v22 即可——装法本身是这些工具自己的文档，本页不重抄。

## 可选的 agent runtime（按需装，不装也能用其它 backend）

| runtime | 安装 | 用途 |
|---------|------|------|
| opencode | `npm install -g opencode-ai` | 作为 MCP Lead host；项目级配置见[接入宿主与绑定项目](host.md) |
| zcode（ZCode 桌面版） | 从 [ZCode 官网](https://zcode.z.ai) 下载安装并登录 | 进程式 backend：GLM 车道用桌面捆绑的 `zcode.cjs`，registry 怎么填见 `AGENT_ONBOARDING.md` §4c；也可作 MCP 宿主（[接入宿主与绑定项目](host.md)） |
| claude code | 见 [anthropic 官方](https://docs.anthropic.com/en/docs/claude-code) | 进程式 backend（需登录：`claude login`） |
| codex | `npm i -g @openai/codex` | 进程式 backend（需登录：`codex login`） |
| kimi code | 见 [kimi-cli 官方](https://platform.moonshot.cn/) | kimi-web 车道的宿主程序：车道连它的 `kimi web` 本地服务（私有主目录先 `kimi login` 一次；serve 何时自动拉起见[车道](lanes.md)）；也可作 MCP 宿主（[接入宿主与绑定项目](host.md)） |
| DeepSeek Harness（ACP 面） | `dsh` CLI ≥ 0.1.5-rc（见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)） | `deepseek-acp` backend：`dsh --profile acp` + 操作员安装的 containment 覆盖层 + `DEEPSEEK_API_KEY`；WAO 只 detect / invoke / report。安装步骤与限制见 `docs/certification-runbook.md`「DSH 通道适用限制与能力交叉警告」 |


你不需要全装，装一个就能用。不同 agent 可以用不同 backend。

claude-code 车道（native OAuth 通道）的 worker 会话运行于临时隔离配置目录：用户日常 `~/.claude` 的技能/插件/设置对 WAO 派发的会话不可见（设计行为，含 `--add-dir` 逃生门）。见 `docs/troubleshooting.md` §7.12。

### 凭据 env（credentialEnv / tokenEnv 车道需要）

声明 `credentialEnv`（deepseek-acp）或 `tokenEnv`（kimi-web）的车道从 env 读 key。按你用的车道配：`DEEPSEEK_API_KEY` / `KIMI_WEB_TOKEN`。key 的验证与排错见 `docs/troubleshooting.md` §1.1/§1.5。`npm run cli -- wao doctor` 按 registry 里 worker 声明的 env 名查 key：进程 env 命中为 OK；仅在 Windows User 作用域命中为 INFO（派发时由凭据桥从 User 作用域注入，不必为 WAO 重启终端）；都没有为 FAIL（附 setx 修复提示）。各车道该设哪个 env 名见 `AGENT_ONBOARDING.md` §4c 的认证选择表。

## 安装本工具

clone、`npm ci`、可选 `npm link` 的操作步骤（含 `install.ps1` 一条命令形态）见 `AGENT_ONBOARDING.md` §4a，本页不重复。本页保留全局 `wao` 的安装根解析：

经全局 `wao` 命令调用时，`config/default.json`、run 目录（`runs/`）与 agent registry（`config/`）从受信安装根（`npm link` 链接的这份 checkout）解析，而非当前目录。安装根由 `bin/wao.js` 自身位置（`import.meta.url`）派生，作为子进程 env（`WAO_INSTALL_ROOT`）传给 CLI 子进程：不经 argv、不拼 shell 字符串，并覆盖调用方任何同名值。因此 `--cwd` 只决定命令作用于哪个 Git 项目（run 族的派发目标、观察与过滤面），不改变这三样的解析位置；显式 `--run-dir` / `--registry` 覆盖照原样使用、不被重定位；`npm run cli -- ...`（不带该 env）保持从当前目录解析。

## 配置

1. worker registry（`config/agents.json`）的配置步骤——从入库模板复制、裁剪到一个能认证的 worker、`wao onboarding --agent <id> --apply` 自动化——见 `AGENT_ONBOARDING.md` §4c。派发选择怎么用认证结果，见 `docs/certification-runbook.md` §认证结果用于派发选择的边界。
2. （可选）编辑 `config/default.json` 覆盖全局默认值（键集、语义与缺省值见 `docs/02-architecture.md` §8；`waitTimeout` 设值须在 1000..600000）。

## 验证安装

registry list / validate 与 `wao doctor` 的自检步骤见 `AGENT_ONBOARDING.md` §4d；各命令的作用见 `npm run cli -- --help`（生成副本：docs/surface/cli.md）。

车道怎么配置与维护见[车道配置与维护](lanes.md)。smoke、runtime certification（`npm run reliability`）与 drill 转录维护命令见 `docs/certification-runbook.md` §认证与转录维护命令。
