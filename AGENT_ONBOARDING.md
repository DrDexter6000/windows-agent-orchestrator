# Agent Onboarding — WAO 安装与上手指南

> 你是一个 agent runtime（codex / claude-code / kimi-code / 其它），被要求把 WAO（Windows Agent Orchestrator）当作技能安装并使用。
> 本文档是你的入职手册。读完它，你就知道：WAO 是什么、怎么装、怎么自检、怎么安全地开始调度 worker。
>
> **如果你已经是 WAO 主控（已装好）**：跳到 §4 开始用。本文档是首次安装时读的。

---

## 1. WAO 是什么

WAO 是一个 **Windows 原生、headless 的 agent 编排控制平面**。它不自己推理，而是调度其它 agent runtime（claude-code / codex / kimi-code / opencode-serve）作为 worker 干活，自己负责：dispatch、transcript 记录、worktree 隔离、resume、metrics、scorecard 门控、workflow DAG、状态外化。

**你的角色**：你是主控（lead）。你用 WAO 的命令派发任务给 worker，监控、验收、整合。你不直接干全程——你编排。

**核心原则**（不可违反，详见 `SKILL.md` §安全铁律）：
1. 编排逻辑不灌进 worker 的 system prompt（worker 只看到干净任务 prompt）
2. transcript 是事实来源（不是 session context）
3. 状态外化到 `.wao/` 文件（不依赖 session 活着）

---

## 2. 部署模型（必读，避免装错位置）

WAO 是**"装一次，开发多个项目"**的工具。有两件不同的事，不要混淆：

| 事 | 做几次 | 装在哪 | 是什么 |
|---|---|---|---|
| **装 WAO skill** | 一次 | **runtime 的 skill 目录**（如 `~/.codex/skills/`、`~/.claude/skills/`） | 让 runtime 知道 WAO 这个技能存在 |
| **初始化目标项目的 .wao/** | 每个被开发项目一次 | **目标项目根目录**（如 `<目标项目>` 仓） | 该项目的状态/决策/交接记录 |

**关键区分**：
- WAO skill 本身**装在 runtime 目录，不装在被开发项目里**。装到项目目录会污染项目（owner 明确要求不污染）。
- `.wao/` 建在**被开发的目标项目里**（因为它记的是那个项目的开发状态）。
- agents.json 里 worker 的 `cwd` 是**动态的**——派发时由 Lead 用 `--cwd <目标项目>` 指定，不写死。agents.json 只配 backend/model/认证。

## 3. 前置条件检查

在安装前，确认环境满足（不满足的项要先用 WAO 的 doctor 报告给 owner）：

- **Node.js >= 22**（WAO 是 Node ESM，零 npm 依赖）
- **worker CLI 在 PATH**：至少一个你想调度的 runtime（claude / codex / kimi / opencode）
- **provider API key**：在 Windows User 环境变量里（ZHIPU_API_KEY / DEEPSEEK_API_KEY / KIMI_API_KEY）
- **WAO 项目目录**：owner 会告诉你 WAO 装在哪（通常是 `D:/projects/windows-agent-orchestrator-poc`）。**这个目录是 WAO 的源码 + 配置所在，不是被开发项目。**
- **Claude OAuth trap 已隔离**：provider-wrapped claude-code worker（researcher/coder_hq/coder_low）会用 WAO wrapper 设置独立 `CLAUDE_CONFIG_DIR`，避免读取用户 `~/.claude` 里的 `claudeAiOauth` 凭证并覆盖 provider key；auditor 不走 wrapper，仍使用官方 Claude OAuth。

---

## 4. 安装步骤

> **怎么调用 WAO 命令（必读）**：本文档所有命令都用 `npm run cli -- <command>`。
> WAO 必须跑在 **Node v22**（v24 有 libuv Windows Job Object 回归，进程隔离会失效）。
> 系统 PATH 里的默认 `node` 可能是 v24，**直接 `node <WAO>/src/cli.js` 会被 version guard 拒绝**；
> `npm run cli` 走 `scripts/wao-node.cjs`（自动用 v22 shim），是唯一可靠的入口。
> 下面命令里的 `<WAO目录>` 指 WAO 仓的根路径，`<目标项目>` 指你要开发的项目根。

### 4a. 装 WAO skill 到 runtime 目录（一次性）

WAO 的 `SKILL.md` 符合 anthropic skill-creator 规范。各 runtime 的 skill 发现机制不同：

- **codex**：按你的 plugin/skill 系统注册（通常是 `~/.codex/skills/wao-orchestrator/SKILL.md` 或等价机制）
- **claude-code**：复制 SKILL.md 到 `~/.claude/skills/wao-orchestrator/SKILL.md`
- **kimi-code**：`~/.kimi-code/config.toml` 的 `extra_skill_dirs` 指向含 SKILL.md 的目录
- **其它**：按你的 runtime 文档

**不要把 WAO skill 装到被开发项目目录**（如 `<目标项目>`）——那是目标项目，不是 runtime 目录。装错位置会污染项目。

**WAO 故意不进 PATH**——它是本地仓内工具，用 `npm run cli -- <command>` 调（走 v22 shim）。系统 PATH 里**没有 `wao` 命令是正常的，不是安装缺失**。原因：WAO 必须跑 Node v22，若链进 PATH 会被系统默认 node（常是 v24）拉起、被 version guard 拒绝。所以别 `npm link` / 别加 PATH，始终从 WAO 仓根用 `npm run cli --` 调。

### 4b. 读 WAO 文档（第一次必读）

1. **读 `SKILL.md`**：WAO 的技能定义（命令参考、workflow、避坑、安全铁律）。
2. **读 `references/safety-incidents.md`**：安全铁律的详细背景（真实事故）。**不读懂不要派发任务**。

### 4c. 在目标项目初始化 .wao/（每个被开发项目一次）

切换到你要开发的目标项目目录，跑（在 WAO 仓根目录下执行）：

```
npm run cli -- wao init --cwd <目标项目>
```

这会在目标项目根建 `.wao/`（5 槽位：project/state/decisions/handoff/runs），并追加到该项目的 `.gitignore`。

### 4d. 安装后自检（必做）

```
npm run cli -- wao doctor --cwd <目标项目>
```

这会检查：Node 版本、各 CLI 在 PATH、provider key、agents.json 配置（opencode worker 有没有配 tokenBudget——06-18 事故防线）、目标项目的 .wao/ 是否初始化。

**doctor 必须报 HEALTHY 才能开始用。** 任何 FAIL 项都是潜在风险，报告给 owner 决定是否修复后再用。

Registry command split: registry list = inventory + certification status; registry validate = static schema; registry check = live opencode health.

---

## 5. 开始用：最小闭环

### 第一个任务（最安全的验证）

用一个**进程式 worker**（claude-code 或 kimi-code，不是 opencode）跑一个最小任务，验证端到端：

```
npm run cli -- run coder_low --prompt "Read package.json and report the package name. One sentence." --cwd <目标项目> --registry <WAO目录>/config/agents.json --format json
```

`coder_low` 是当前标准 registry 里的轻量 claude-code worker（进程式，进程死即会话死，适合最小验证）。如果这个跑通返回 `completed: true` + assistant 文本，说明 WAO 调度链路通了。`--cwd <目标项目>` 指定被开发项目，`--registry <WAO目录>/config/agents.json` 指定 WAO worker registry；首次上手不要省略这两个参数。

### 派发 GLM 任务（推荐用 coder_hq 或 coder_low，不是 opencode coder）

```
npm run cli -- run coder_hq --prompt "你的任务" --cwd <目标项目> --registry <WAO目录>/config/agents.json --format json
```

`coder_hq` 是 GLM-5.2 via claude-code wrapper（进程式 + 已 probe 验证），适合较重编码任务；轻量任务继续用 `coder_low`。**不要默认用 opencode worker**——它有 stop 虚假成功风险（06-18 事故），只在需要 token 闸门精确控成本时用，且必配 tokenBudget。

### 记录状态（每次任务后）

用 `.wao/` 命令记录，**不要自己新建文档文件**（会导致文档熵增）：

```
# 记录一个决策
npm run cli -- wao decision add --title "为什么选 X" --body "理由"

# 写交接卡（给下游 worker）
npm run cli -- wao handoff write --from lead --to coder --summary "任务描述"

# 读当前项目进度
npm run cli -- wao state read
```

---

## 6. 安全边界（绝对不可违反）

这些来自真实事故（烧掉上亿 token 的教训），详见 `references/safety-incidents.md`：

1. **opencode worker 必须配 `tokenBudget`，否则不要派发。** 没配 budget 的 opencode worker = 06-18 事故配置。
2. **默认用进程式 worker（claude-code / kimi-code），不是 opencode。** 进程死即会话死，OS 保证。
3. **`stop` 之后看 `stop_verified`，不只看命令返回。** abort 返回 200 ≠ 后台停了。
4. **任务结束后检查残余进程：** `tasklist | grep opencode`。看不见的后台进程曾烧了一夜 token。
5. **用 `.wao/` 记录，不新建文档，不把上下文塞 session。**

**核心**：token 拿来用是投资，可接受；无人值守的无用循环 + 不清理残余，绝对不可接受。

---

## 7. 进阶：workflow 编排

单任务验证通过后，可以编排多节点 workflow（DAG）。详见 `SKILL.md` §workflow。

workflow 跑的过程中，`.wao/state/current.md` 会自动更新（每个节点完成落盘）——这是断点续接的基础。崩了重启，读 current.md 就知道跑到哪。

---

## 8. 遇到问题

- **worker 401**：provider key 没配（`wao doctor` 会查出）
- **opencode worker 卡住**：serve 没起 或 key 没注入 serve 进程（用 `scripts/serve.ps1` 起 serve）
- **run 失控（烧 token）**：立即 `npm run cli -- stop <runId>`，看 `stop_verified`；未验证则 `taskkill /IM opencode.exe /F`
- **不确定环境**：跑 `wao doctor`

详细排障：`docs/troubleshooting.md`。

---

## 给 owner 的话

这份文档是给 agent runtime 读的。如果你（owner）要让一个新 runtime 上手 WAO：
1. 把 WAO 目录路径告诉它
2. 让它读本文件
3. 让它跑 `wao doctor`
4. doctor HEALTHY 后，让它跑 §5 的最小任务验证

onboarding 文档本身用 `.wao/` 机制维护——更新时用 `wao decision add` 记录变更原因，不要直接堆砌版本历史。
