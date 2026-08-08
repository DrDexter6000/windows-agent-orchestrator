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
- worker 的 `cwd` 是**动态的**——CLI 派发时由 Lead 用 `--cwd <目标项目>` 指定；MCP 派发时 workspace 来自 host 授权绑定（`--workspace-root` / `roots/list` / `workspace_select`）。agents.json 只配 backend/model/认证，不写死 cwd。

## 3. 前置条件检查

在安装前，确认环境满足（不满足的项先跑 §4d 的 doctor 报告给 owner——doctor 是建议性报告，不是使用门禁）：

- **Node.js >= 22**（WAO 是 Node ESM，依赖 `@modelcontextprotocol/sdk` + `zod`，用 `npm install` 安装）
- **worker CLI 在 PATH**：至少一个你想调度的 runtime（claude / codex / kimi）——**一个 runtime 就够**，不需要全部装齐
- **认证任选其一**：官方 Claude OAuth（`claude login`）、provider key（`DEEPSEEK_API_KEY` / `ZHIPU_API_KEY`）、`codex login`、或 Kimi Code 登录态——选你有的那一种即可，见 §4c 选择表
- **WAO 项目目录**：owner 会告诉你 WAO 装在哪（通常是 `D:/projects/windows-agent-orchestrator-poc`）。**这个目录是 WAO 的源码 + 配置所在，不是被开发项目。**
- **Claude OAuth trap 已隔离**：provider-wrapped claude-code worker（researcher/coder_hq/coder_low）会用 WAO wrapper 设置独立 `CLAUDE_CONFIG_DIR`，避免读取用户 `~/.claude` 里的 `claudeAiOauth` 凭证并覆盖 provider key；auditor 不走 wrapper，仍使用官方 Claude OAuth。

---

## 4. 安装步骤

> **怎么调用 WAO 命令（必读）**：本文档所有命令都用 `npm run cli -- <command>`。
> WAO 必须跑在 **Node v22**（v24 有 libuv Windows Job Object 回归，进程隔离会失效）。
> 系统 PATH 里的默认 `node` 可能是 v24，**直接 `node <WAO>/src/cli.js` 会被 version guard 拒绝**；
> `npm run cli` 走 `scripts/wao-node.cjs`（自动用 v22 shim），是唯一可靠的入口。
> 下面命令里的 `<WAO目录>` 指 WAO 仓的根路径，`<目标项目>` 指你要开发的项目根。
>
> 第一次必读：**`SKILL.md`**（命令参考、workflow、安全铁律）和 **`references/safety-incidents.md`**（铁律背后的真实事故）。不读懂不要派发任务。

### 4a. 装 WAO 本体（一次性）

```powershell
git clone https://github.com/DrDexter6000/windows-agent-orchestrator.git <WAO目录>
cd <WAO目录>
npm ci             # 按入库的 package-lock 精确安装；`npm install` 只在需要放宽版本时作回退
npm link           # 可选，每台机器一次：暴露顶层 `wao` 命令（如 `wao dashboard`）
```

`npm link` 的作用范围：只提供**顶层** `wao` 命令（`wao dashboard` 这类单个词命令）；**嵌套命令族**（如 `npm run cli -- wao doctor`、`npm run cli -- registry list`）仍用 `npm run cli --` 调——npm link 不是它们的全局拼写替代。不 link 时全部命令都用 `npm run cli -- <command>`。

### 4b. 装 WAO skill 到 runtime 目录（一次性）

WAO 的 `SKILL.md` 符合 anthropic skill-creator 规范。各 runtime 的 skill 发现机制不同：

- **codex**：按你的 plugin/skill 系统注册（通常是 `~/.codex/skills/wao-orchestrator/SKILL.md` 或等价机制）
- **claude-code**：复制 SKILL.md 到 `~/.claude/skills/wao-orchestrator/SKILL.md`
- **kimi-code**：`~/.kimi-code/config.toml` 的 `extra_skill_dirs` 指向含 SKILL.md 的目录
- **其它**：按你的 runtime 文档

**不要把 WAO skill 装到被开发项目目录**（如 `<目标项目>`）——那是目标项目，不是 runtime 目录。装错位置会污染项目。

### 4c. 配置 worker registry：一个 worker 就够

先分清两个文件的作用域，不要混淆：

- **`config/agents.example.json`（入库的模板）**：与 `docs/team-roles.md` 规范角色**一一对应**，保持六个角色 worker（researcher / coder_hq / coder_low / coder_mm / tester / auditor + opencode fallback）全量——它是上游样例，不需要编辑它本身。
- **`config/agents.json`（你的私人副本，gitignored 不入库）**：复制后**可以删到只剩你实际能认证的 worker**。

> **自动化（可选）**：`npm run cli -- wao onboarding --agent <你保留的 worker id> --apply` 从入库模板自动生成只含一个 worker 的 `config/agents.json`（零手编、带该 worker 的认证矩阵、并打印 host-neutral MCP 片段）。下面的手动复制+裁剪是同一结果的等价做法。正式验收链见本文档 §9。

```powershell
Copy-Item config/agents.example.json config/agents.json
```

**一个 runtime 就够用 WAO**——按你手上有的认证选一行，把其它 worker 条目从你的 agents.json 删掉：

| 你有的 runtime/认证 | 保留的 worker | 认证方式 |
|---|---|---|
| claude-code + 官方 Claude OAuth | auditor | `claude login`（原生 OAuth，不走 provider wrapper） |
| claude-code + DeepSeek key | researcher 或 coder_low | `DEEPSEEK_API_KEY`（Windows User 环境变量） |
| claude-code + GLM key | coder_hq | `ZHIPU_API_KEY`（Windows User 环境变量） |
| codex | tester | `codex login` |
| Kimi Code | coder_mm | Kimi Code 登录态（无需 API key） |

删到只剩一个 worker 也完全可用。每个保留的 worker 里的 `cwd` 可留模板值，派发时覆盖。

### 4d. 自检 registry 与环境（必做）

验证 registry 并自检环境（在 WAO 仓根目录下执行）：

```
npm run cli -- registry list --registry config/agents.json      # inventory + certification 状态
npm run cli -- registry validate --registry config/agents.json  # 静态 schema 校验（不改任何文件）
npm run cli -- wao doctor --cwd <目标项目>                        # 环境自检
```

Registry command split: registry list = inventory + certification status; registry validate = static schema; registry check = live opencode health.

`registry check` 只适用于 opencode-serve 后端（需要先起 `scripts/serve.ps1` 注入 provider key）；没保留 opencode fallback worker 就跳过它。

**doctor 是建议性（advisory）自检报告，不是使用门禁**：它检查 Node 版本、各 CLI 在 PATH、provider key、agents.json 配置（opencode worker 有没有配 tokenBudget——06-18 事故防线）、目标项目的 `.wao/` 是否初始化。FAIL 项是潜在风险，报告给 owner 由 owner 裁决是否修复后再用，不自动阻断。

**（可选）`.wao init` 项目规划记录**：`npm run cli -- wao init --cwd <目标项目>` 会在目标项目根建 `.wao/`（project/state/decisions/handoff/runs 5 槽位），用于记录项目的计划/状态/决策/交接——它不是 MCP workspace 绑定或 `run_dispatch` 的前提，没有 `.wao/` 照样能派发任务；需要项目级记录时再补。

### 4e. 连接 MCP Host（主控通道，Decision 0017）

在 MCP host（Claude Desktop / Codex CLI / OpenCode / 任意 MCP client）里把 WAO 注册为 stdio server：

```
npm run mcp -- --registry config/agents.json --run-dir runs
```

- **CLI `--cwd` 只控制 workspace 观察/过滤**（哪些路径算改动、canary 在哪个项目里跑）。
- **MCP 派发的 workspace 来自 host 授权的绑定**：`--workspace-root` / `roots/list` / `workspace_select` 协商出 host 批准的目录，与 CLI `--cwd` 是两回事，别混。
- 完整的 host 配置示例见 `docs/usage.md` §MCP stdio。

### 4f. 首次只读 canary

用一个**进程式 worker**（claude-code / codex / kimi-code 都行，不是 opencode）跑一个最小只读任务，验证端到端。`<agentId>` 填你在 §4c 保留的那个 worker——从 `registry list` 的输出里挑它的 id 复制过来：

```
npm run cli -- run <agentId> --prompt "Read package.json and report the package name. One sentence." --cwd <目标项目> --registry <WAO目录>/config/agents.json --format json
```

进程式 worker 进程死即会话死，适合最小验证。如果这个跑通返回 `completed: true` + assistant 文本，说明 WAO 调度链路通了。`--cwd <目标项目>` 指定被开发项目，`--registry <WAO目录>/config/agents.json` 指定 WAO worker registry；首次上手不要省略这两个参数。

---

## 5. 开始用：最小闭环

### 派发 GLM 任务（推荐用 coder_hq 或 coder_low，不是 opencode coder）

```
npm run cli -- run coder_hq --prompt "你的任务" --cwd <目标项目> --registry <WAO目录>/config/agents.json --format json
```

`coder_hq` 是 GLM-5.2 via claude-code wrapper（进程式 + 已 probe 验证），适合较重编码任务；轻量任务用 `coder_low`（若保留了它）。**不要默认用 opencode worker**——它有 stop 虚假成功风险（06-18 事故），只在需要 token 闸门精确控成本时用，且必配 tokenBudget。

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
- **不确定环境**：跑 `wao doctor`（advisory，报告给 owner 裁决）

详细排障：`docs/troubleshooting.md`。

---

## 9. 正式验收与认证（MCP-native）

§4f 的 CLI 只读 canary 是**诊断工具**，不是正式验收。**正式验收只能走 MCP-native 链**，且 worker 须先带一个就绪信号。

**就绪信号二选一**（helper 本身不产生就绪，只指路/写手册式放行）：
- **严格认证（推荐）**：`npm run reliability -- --agent <agentId>` 写真实状态（certified/conditional/...）进 `runs/reliability-summary.json`。helper 只报告这条命令，不替你跑。
- **手册式放行**：`npm run cli -- wao onboarding --agent <agentId> --endorse-worker <agentId>` 仅写 `manualOverride: "cleared"`（既有 Owner 信号），不动 status、不捏造就绪。`--endorse-worker` 必须与 `--agent` 完全一致；可单独或配合 `--apply` 使用。

**正式验收链**（三个 MCP 工具，按序）：

```
lead_preflight  →  run_dispatch（只读、no-delivery canary）  →  run_await_result
```

1. `lead_preflight`：确认 registry/环境可派发（advisory，非硬门）。
2. `run_dispatch` 发一个**只读、不带 delivery** 的 canary（如"读某文件，一句话汇报"），只验证 dispatch/transcript/worker 链路通，不产出交付。
3. `run_await_result`：等终态 + assistant 文本。

**PASS 判据**（三者同时成立）：**clean terminal**（transcript 无 `run.error`/失败事件）+ **终态 `completed`** + **非空 assistant 文本**。缺一不可。

**`run_dispatch` accepted ≠ PASS**：返回 `runId` 只表示派发被接受、开了 transcript，不等于 worker 成功。只有 `run_await_result` 到 `completed` + 非空 assistant 文本 + clean terminal 才算 PASS。

**非 PASS 的四个诊断分支**（映射控制平面 closed-set `DIAGNOSIS_CATEGORIES`，只给事实不给处方）：
1. **provider / 认证**（`provider_auth` / `config_conflict`）：401、key 缺失/无效、OAuth 与 provider key 优先级冲突。
2. **worker 空停**（`crash` / `no_effect` / `provider_disconnect`）：进程非零退出、有活动无产出、或静默≥120s 后死。
3. **超时 / 传输窗口到期**（`timeout` / 等待窗口 / MCP 传输断）：**传输或窗口到期 ≠ worker 停止**——是控制器不再等/stdio 断了，worker 进程可能还活着，别当成 crash，先查进程/重新 await。
4. **PASS**：clean terminal + `completed` + 非空 assistant 文本。

**host-neutral MCP 片段**：`wao onboarding` 会打印一段通用 `mcpServers.wao` stdio 片段（入口是 Node v22 shim `scripts/wao-node.cjs`，绝对路径正斜杠规范化、带空格也能用）。完整的 host 配置示例以 `docs/usage.md` §MCP stdio 为权威——本文不复制。

---

## 给 owner 的话

这份文档是给 agent runtime 读的。如果你（owner）要让一个新 runtime 上手 WAO：
1. 把 WAO 目录路径告诉它
2. 让它读本文件
3. 让它跑 `registry list` / `registry validate` + `wao doctor`
4. doctor 报告无阻点（或你裁决可继续）后，让它跑 §4f 的只读 canary

onboarding 文档本身用 `.wao/` 机制维护——更新时用 `wao decision add` 记录变更原因，不要直接堆砌版本历史。
