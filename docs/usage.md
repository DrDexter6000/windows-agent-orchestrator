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

WAO 进程式 backend（claude-code/codex/kimi-code/deepseek-harness）的"进程死即会话死"隔离，依赖 **Node 自 v18+ 内置的 Windows Job Object**（父进程退出→OS 自动杀全部子进程树）。**Node v24 有 libuv Job Object 回归**（会误杀长进程），所以 WAO 在 cli / daemon / background-runner 入口**硬拒绝 v24**并指引切 v22。详见 TD-40 + `.wao/decisions/0013`。

- v24 上启动会看到：`WAO 拒绝启动：Node v24.x 被拒绝：v24 has a libuv Windows Job Object regression ... 请用 v22`，exit 1。
- `npm test` 同样走 v22 shim：入口为 `node scripts/wao-node.cjs scripts/canonical-test.mjs`，canonical runner 读 `test/manifest.json` 把每个 `.test.js` 恰好归入一个资源类别（pure/git/worktree/process/lock/timeout，用于归属与漂移检测），执行组织成串行波（wave）：同一波池化多个类别共享有界并发、长极重叠（filesystem 波池化 git+worktree，lock 波严格串行），并对首轮失败隔离复核一次（只追加 stable_fail/isolation_pass/environment_invalid 分类，绝不把复核通过洗成 PASS）。测试本身 mock 子进程、不依赖真实进程隔离；子进程注入 `WAO_SKIP_VERSION_GUARD=1` 绕过版本守卫。

#### 如何装 / 切到 v22

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

### 可选的 agent runtime（按需装，不装也能用其它 backend）

| runtime | 安装 | 用途 |
|---------|------|------|
| opencode | `npm install -g opencode-ai` | HTTP 类 backend（需先 `opencode serve`）；也可作为 MCP Lead host（见 §MCP stdio OpenCode 项目级配置） |
| claude code | 见 [anthropic 官方](https://docs.anthropic.com/en/docs/claude-code) | 进程式 backend（需登录：`claude login`） |
| codex | `npm i -g @openai/codex` | 进程式 backend（需登录：`codex login`） |
| kimi code | 见 [kimi-cli 官方](https://platform.moonshot.cn/) | 进程式 backend，多模态（需过 Kimi 白名单，无需登录命令） |
| DeepSeek Harness | 见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | **实验性** stdio JSON-RPC backend；需用户自行准备 dedicated `dsh-jsonrpc-agent` composition 与 `DEEPSEEK_API_KEY`，WAO 不安装或修复 runtime |

**你不需要全装。** 装一个就能用。不同 agent 可以用不同 backend。

#### Provider key（claude-code wrapper / opencode serve 需要）

claude-code 经 wrapper 调非 Claude provider（GLM/DeepSeek）时，wrapper 读 env 里的 key；opencode serve 也需 provider key。所需 env：`ZHIPU_API_KEY` / `DEEPSEEK_API_KEY` / `KIMI_API_KEY`（按你用的 provider 配）。**详细的 key 验证 / 注入 / 401 排错见 `docs/troubleshooting.md §1.2`**（用 `scripts/serve.ps1` 启动 serve 会从 User registry 读 key 注入）。`npm run cli -- wao doctor` 按 registry 保留 worker 声明的 env 名查 key（scoped）：进程 env 命中为 OK；仅在 Windows User 作用域命中给 WARN（新开终端可用）；都没有才 FAIL（附 setx 修复提示）。

### 安装本工具

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

此后顶层命令可直接运行——如 `wao dashboard`（本启动器，见 §Owner 本地只读看板）——不必 `cd` 进 WAO 仓库，也不用担心 `npm run cli` 从其它目录报 "Missing script: cli"。注意只有顶层命令可用 `wao <command>` 形式；嵌套在命令族下的命令（如 `wao doctor`）仍需 `npm run cli -- wao doctor` 原形式。

**共享状态解析根（M12-8F）：** 经全局 `wao` 命令调用时，WAO 把 `config/default.json`、run 目录（`runs/`）与 agent registry（`config/`）从**受信安装根**（即 `npm link` 链接的这份 checkout）解析，而非当前目录。该安装根由 `bin/wao.js` 自身位置（`import.meta.url`）派生，作为子进程 env（`WAO_INSTALL_ROOT`）传给 CLI 子进程——不经 argv、不拼 shell 字符串，并覆盖调用方任何同名值（受信、不可注入）。因此 `--cwd` 仍只决定命令观察/过滤哪个 Git 项目（如看板按 ownership 过滤的目标 workspace），显式 `--run-dir`/`--registry` 覆盖照原样使用、不被重定位；`npm run cli -- ...`（不设该 env）保持从当前目录解析的遗留行为不变。

### 配置

**1. 复制 registry 模板并编辑：**
```powershell
Copy-Item config/agents.example.json config/agents.json
```

编辑 `config/agents.json`，按需增删 agent。`cwd` 模板默认是 `.`（R8-1：解析为发起派发的进程的当前工作目录——CLI 通道=你敲命令时所在目录；MCP 通道=MCP 服务进程的 cwd，由 host 决定；恒存在，开箱即跑）——要固定目标项目就改成真实路径（必须已存在），或保持 `.` 由派发时 `--cwd` 覆盖（`wao doctor` 对 cwd 为 `.` 的 worker 会出一条 INFO 落点提示，不计 DEGRADED）。

> 第三方从全新 clone 只配一个 worker：`npm run cli -- wao onboarding --agent <agentId> --apply` 自动从入库模板生成单 worker registry + host-neutral MCP 片段（零手编）。正式验收链见 `AGENT_ONBOARDING.md` §9。
> 已生成 `config/agents.json` 后裸跑 `npm run cli -- wao onboarding`，角色矩阵按双源展示（决策 0024）：已配置行（真实状态、私有 registry 顺序）在前，模板未配置候选（行尾 `·模板候选`）在后；同 id 但 backend/model 漂移的行挂 `·drift` 并在表后列有界明细；`--apply` 仅适用模板候选行。还没生成（或不可读）时是纯模板面，输出不变。

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
      "model": { "id": "deepseek-v4-pro", "contextWindow": 1000000 },
      "reasoning": { "effort": "max" },
      "cwd": "D:/projects/my-app",
      "args": ["--dangerously-skip-permissions"]
    },

    // ── deepseek-harness（实验性；不要从 GUI preset/TUI 抓输出）──
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

`seatRole`（R10-B）是三席会审（决策 0023）的显式席位声明，闭集为
`"adversarial"`（对抗席）/ `"implementation"`（实现席）/ `"non_seat"`（非席位）——registry
schema、就绪分级引擎与展示层共用同一词表（`registry validate` 对闭集外或非字符串值固定拒绝，
错误信息不回显坏值）。**省略该字段合法**：席位角色回退命名惯例（`auditor`/`coder_mm` = 对抗席、
`coder_` 前缀 = 实现席、其余非席位），老 registry 零迁移。新配置建议显式声明——惯例对
`coder_opencode_fallback` 这类"名字像实现席、实为 fallback 非席位"的 worker 会误分类，
显式 `"non_seat"` 才能把它从席位候选剔除。

`deepseek-harness` 配置只负责 detect/invoke/report：WAO 要求 `binary` 指向一个可启动的
DSH SDK JSON-RPC runtime，`dshConfigPath` 可读，`credentialEnv` 只写环境变量名；凭据值仍由
现有 Windows user-env bridge 注入子进程。DSH composition 应关闭内部 subagent、workflow、
approval UI、background job 和 TUI，把模型、PowerShell/编辑工具与 JSONL session storage 显式
装配进去。WAO 不生成、升级或持久修复该外部 runtime。该 backend 目前无 session reuse / in-flight
correction，且本仓模板不把它设为默认 worker；通过 `npm run reliability` 取得与当前
backend+model 精确绑定的认证前，registry 会诚实显示 `certification:null`。

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

### 场景 1b：单次派发换模型（--model，R10-A）

"这一次任务的会审选用 codex CLI 驱动的 gpt-5.6-sol-xhigh" 这类**单次生效、不落配置**的模型覆盖：

```powershell
# 前台：立即回显 effective model，然后照常等待并打印摘要
npm run cli -- run coder_low --prompt "..." --model gpt-5.6-sol-xhigh

# 后台：JSON 里带 model 字段（派发时刻即见，不必等 provider）
npm run cli -- run coder_low --prompt "..." --background --model gpt-5.6-sol-xhigh
```

语义要点：

- **只替换 `model.id`**：注册表里 model 是嵌套对象（canonical `{id, contextWindow?}`；opencode-serve 是 `{providerID, id, variant}`）。覆盖只改 `.id`，兄弟字段（contextWindow / providerID / variant）全部保留；注册表没有 model 的 worker 会合成出 `{id}`。合成发生在 `validateAgentPolicy` 与 `run.started` 落盘之前——策略校验照常跑合成后的对象，`run.started` 的 `model` 字段即合成后策略，并**另加显式 `modelOverride` 字段**（审计可区分"改注册表"与"一次性覆盖"）。
- **回显 effective model**：前台 text 格式在派发成功时打印一行 `effective model: {...}`；`--format json` 把同一对象作为结果里的 `model` 字段；后台 JSON 输出带 `model` 字段。**失败模式**：WAO 不校验模型 id 是否真实存在——打错的模型名要到 provider 期（worker 启动后）才报错，回显就是让你在派发时刻立刻看见打错了什么（回显是 advisory：展示的是 WAO 实际下发了什么，不证明 provider 接受该 id）。
- **resume 继承覆盖事实（R10-C C-1）**：`resume`（含 daemon `--resume-on-start` 接管）从 `run.started.modelOverride` 同源重建覆盖——后台派发带 `--model` 后 runner 崩溃、daemon 接管续跑时，后半程仍跑派发时的模型，transcript 里的覆盖事实不再失真。合成与形状门与 start 同一道（只替换 `.id`；持久化值非法则拒绝 resume，fail-closed）；resume 不接受调用方新传的覆盖。
- **两道硬互斥（fail-fast，零副作用）**：
  1. `--model` × `--require-certified`（闭集码 `model_override_certified_conflict`）：无条件互斥——认证矩阵按 provider+model 组合记录，任何覆盖（即使值与注册表一致）都使"已认证组合"声明失效。CLI 在 argv 边界早拒；`RunManager.start` 顶部作权威拒绝（前台/后台/workflow/daemon 全通道同一语义）。
  2. `--model` × provider-session 复用派发（闭集码 `model_override_reuse_conflict`，typed `ModelOverrideConflictError`）：reusable expert（`sessionReuse: "lead_workspace"`）与 continuable delivery 谱系根两形状都拒——跨回合续用的 provider 会话必须跑同一个模型（resume 侧只从 `run.started` 重建该 run 自己的覆盖事实、不接受调用方新传覆盖，R10-C C-1；派发时再换模型会破坏 provider 会话契约）。dispatchRun 在路由槽/transcript/fork 之前拒绝。
- **正交放行**：`--model` × `--read-only` 可同用（金丝雀换模型试跑是合理用法）；`--model` × `--delivery-spec-file`（及 MCP `delivery` 块）放行，但注意**该 run 的认证组合声明失效**——reliability 认证按注册表的 provider+model 组合记录，覆盖后的组合未经认证；override 事实已由 `run.started.modelOverride` 入 transcript 供审计。
- **形状门**（对齐 canonicalAgentId 纪律）：非空 string、长度 ≤128、不以 `--` 开头、不含空白/控制字符。`--` 前缀规则是承重的——后台 runner 的 `parseSimpleFlags` 会把 `--` 开头的值当下一个 flag，值对会静默断裂。违规以固定文案 fail-fast（不回显原值）。MCP `run_dispatch` 的 `model` 参数走同一 SSOT（wire schema 正则与核心校验器同源）。
- **排除边界**：`--model` 只存在于 `run`（含 `--background`）与 `retry`（retry 上为替换继承值，见场景 5）。`spawn` 显式拒绝（多席统一模型语义混浊，Owner 场景是单派发）；workflow agent 节点与 daemon 派发不解析该 flag——声明式表面的模型应写进声明本身（注册表 model 策略）。持久换模型 = 改注册表，不是加 flag。

### 场景 1c：单次派发换推理力度（--reasoning，R11-1）

"这一次会审用 gpt-5.6-sol 配 xhigh 推理力度" 这类**单次生效、不落配置**的推理力度覆盖（与 `--model` 可同用）：

```powershell
# 前台：立即回显 effective reasoning（与 --model 同用时合并为一行 effective 回显）
npm run cli -- run coder_low --prompt "..." --reasoning xhigh

# 与 --model 同用（Owner 场景 "gpt-5.6-sol + xhigh"）
npm run cli -- run coder_low --prompt "..." --model gpt-5.6-sol-xhigh --reasoning xhigh

# 后台：JSON 里带 reasoning 字段（派发时刻即见，不必等 provider）
npm run cli -- run coder_low --prompt "..." --background --reasoning xhigh
```

语义要点：

- **只替换 `reasoning.effort`**：注册表里 reasoning 是嵌套对象（canonical `{effort}`）。覆盖只改 `.effort`，合成发生在 `validateAgentPolicy` 与 `run.started` 落盘之前——策略校验照常跑合成后的对象；`run.started` 的 `reasoning` 字段即合成后策略（R11-1 起无条件落盘——今天起也补上**静态** reasoning 的审计缺口），并**另加显式 `reasoningOverride` 字段**（审计可区分"改注册表"与"一次性覆盖"）。
- **闭集值域**：`minimal / low / medium / high / xhigh / max`（`registry.js` 的 `REASONING_EFFORTS` SSOT，六值导出）。集外值（含大小写变体如 `HIGH`）以固定文案 fail-fast（不回显原值）。MCP `run_dispatch` 的 `reasoning` 参数走同一 SSOT——wire schema 直接序列化闭集枚举（比正则更严）。
- **无能力布尔（设计决策）**：不可表达（opencode-serve 拒绝任何 `reasoning.effort`）与条件不支持（kimi 仅 K3 模型 × {low,high,max}；deepseek-harness 仅 high|max）都走**既有 per-backend policy 门自然拒绝**——合成后的对象照常过 `validateAgentPolicy`，拒绝时追加指对 `--reasoning` 旗标的固定提示句（不回显值）。平面"能力布尔"编码不了这些条件支持，故不设。
- **与 `--model` 可同用**：两个覆盖各改各的字段（`.id` / `.effort`），互不干扰；前台回显合并为一行 `effective model: {...}, reasoning: {...}`（advisory：展示 WAO 实际下发了什么，不证明 provider 接受）。
- **resume 继承覆盖事实（R11-1）**：`resume`（含 daemon `--resume-on-start` 接管）从 `run.started.reasoningOverride` 同源重建覆盖——后台派发带 `--reasoning` 后 runner 崩溃、daemon 接管续跑时，后半程仍跑派发时的力度。合成与闭集门与 start 同一道；持久化值非法则拒绝 resume（fail-closed，零 re-spawn）；resume 不接受调用方新传的覆盖。
- **两道硬互斥（fail-fast，零副作用，"任一覆盖在场即拒"）**：
  1. `--reasoning` × `--require-certified`（闭集码 `reasoning_override_certified_conflict`）：无条件互斥——覆盖改变认证组合被测量时的执行包络，任何覆盖都使"已认证组合"声明失效。CLI 在 argv 边界早拒；`RunManager.start` 顶部作权威拒绝。
  2. `--reasoning` × provider-session 复用派发（闭集码 `reasoning_override_reuse_conflict`，typed `ReasoningOverrideConflictError`）：reusable expert 与 continuable delivery 谱系根两形状都拒——跨回合续用的 provider 会话必须跑同一推理力度。dispatchRun 在路由槽/transcript/fork 之前拒绝。**组合策略拒绝指对旗标**：`--model` 与 `--reasoning` 同用时撞复用，model 冲突先拒（确定性顺序，runDispatch.js 注明）；policy 门拒绝的提示句按在场覆盖组三种形状（仅 model / 仅 reasoning / 双覆盖）指对旗标。
- **正交放行**：`--reasoning` × `--read-only` / × `--delivery-spec-file`（及 MCP `delivery` 块）可同用（同 `--model` 的认证组合声明失效注意事项）。
- **排除边界**：`--reasoning` 只存在于 `run`（含 `--background`）与 `retry`（retry 上为替换继承值，见场景 5）。`spawn` 显式拒绝；workflow agent 节点与 daemon 派发不解析该 flag——声明式表面的推理力度应写进声明本身（注册表 reasoning 策略）。持久换力度 = 改注册表，不是加 flag。

### 场景 2：后台跑（fire-and-forget）

```powershell
# spawn 不带 --wait，立即返回 runId
npm run cli -- spawn researcher --prompt "分析 auth 模块并列出风险文件"

# 之后查看状态
npm run cli -- status <runId>
npm run cli -- tail <runId>          # 看最后几个事件
npm run cli -- tail <runId> --follow # 实时跟踪

# 阻塞等待 run 到终态（或观察窗口到期）
npm run cli -- runs wait <runId>                     # 默认窗口 270000 ms，text 摘要
npm run cli -- runs wait <runId> --wait-ms 600000    # 窗口 180000..600000 ms
npm run cli -- runs wait <runId> --format json       # 完整服务结果 + semanticNotes
```

`runs wait` 与 MCP `run_wait` 工具共用同一等待服务（只读长轮询，不写 transcript）：
默认 `--format text`（runs 家族惯例），`--format json` 输出完整服务结果并附
`semanticNotes`（与 MCP 同一 selector）。观察窗口到期（`terminal:false`）是正常
结果——正常打印、exit 0，不代表 worker 停止或失败；等待期间 Ctrl-C 会打印中断
时刻的快照后以非零退出。`--wait-ms` 越界或非整数由服务边界原样报错（exit 1）；
非数字值（如 `--wait-ms abc`）在 CLI 层即以固定文案 `--wait-ms must be a number` 拒绝
（不回显原值，service 不被调用）。
`runs` 的未知子命令（如 `runs waitx`）会 fail-closed 报错并列出全部合法子命令；
裸 `runs` 仍保持列出 run 列表。

工作目录（显式 `--cwd`，缺省时 registry 条目的 `cwd`）**必须是已存在的目录**。
不存在（或是文件）时派发/执行在任何副作用之前被拒绝——typed error
`DispatchCwdNotFoundError`（reasonCode `dispatch_cwd_not_found`，message 含解析后的
绝对路径与来源标注；零 transcript、零 fork、零 worktree）。检查按 backend 能力划分
（与 M12-14 invocation 预检同一 capability 键 `preflightInvocation`）：本地进程式
backend（claude-code / codex / kimi-code / deepseek-harness）在两层都查，HTTP serve
backend（opencode-serve，cwd 是远端目录提示）两层一致豁免。**承重层是前台执行通道**
（`run` 前台、workflow agent 节点、daemon `start`、`retry` → RunManager.start，以及
`resume` 的进程重放分支 → RunManager.resume）——2026-08-16 的 22 条 researcher
spawn_error 事故全部走 workflow 通道，即此层；**后台派发通道**（`run --background` /
`spawn` / MCP `run_dispatch` → dispatchRun 派发服务层）是同款 typed 早拒绝的预防面
（transcript 写入与 fork 之前）。判读与旧 transcript 的排障见
`docs/troubleshooting.md §3.2`。

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

> 已知坑（friction 2026-08-15 #3）：spec 文件内容是**内层 delivery 对象本身**——`{"mode":"git_commit_v1","allowedPaths":[...],"verificationCommands":[...]}`，**不带** `{"delivery": ...}` 外层包装（那层包装是 MCP `run_dispatch` 工具参数的形状，见 §四）。CLI 把文件内容直接交给 `prepareDeliveryRequest` SSOT 解析，带外层包装会因缺顶层 `mode` 被拒绝。

CLI 的 run 用法可用 `npm run cli -- run --help` 查看。

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

# 重试时替换源 run 的 per-dispatch 覆盖（显式 flag 优先于继承值）
npm run cli -- retry <runId> --model <id> --reasoning <effort>

# 恢复：接续一个未完成的 run
#   opencode-serve：attach 到已有 session
#   claude/codex：重放原 prompt（进程式无法 attach，只能重放）
npm run cli -- resume <runId> --wait
```

retry 的 per-dispatch 覆盖继承（R12，与 resume 重建链对称）：

- **任务文本取法（R13-C / TD-127）**：retry 派发的任务文本取**本 run 最后一条 `prompt.sent` 记录（纯 runId 绑定）**——尾部追加的跨 runId 伪造记录不采信（信封绑定纪律，读取器 SSOT 在 `transcript.js` 的 `findLatestBound`/`findFirstBound`）；合法双写形状（TD-54：spawn 前首写 + spawn 后补写）仍取最后一条。诚实边界（R13-C 统一口径）：绑定只杀跨 run 注入与错读——同 runId 的伪造追加（无论是否带 `messageId`）仍会被采信；该攻击面等同于持有 `runs/` 写权限，读取端无解，真边界在写入端完整性。R13 曾加"优先取带 `messageId` 的末条"收窄，R13-C 移除：claude-code/codex/kimi-code 均为 ProcessBackend 家族，其合法双写落盘**均无** `messageId`（spawn 结果的 `undefined` 经 JSON 序列化丢键），该收窄对此家族是死代码。
- **行为变更（R13 / R13-C 文案如实化）**：信封时代之前的 legacy transcript（事件无 `runId` 字段）经绑定读取器找不到本 run 的 `prompt.sent` → retry **硬拒绝**（文案如实覆盖两情形："no runId-bound prompt.sent found in this transcript — pre-envelope legacy formats are not retryable through the bound reader; re-dispatch explicitly with `run`"）；`resume` 对无信封 legacy transcript 同样拒绝（return null，与 resume 既有拒绝语义一致）。
- **继承范围（诚实口径，R12-C）**：retry 重新派发**任务文本与 per-dispatch 覆盖**；delivery 声明 / 只读声明 / 隔离形状**不**继承（R12 前既有行为不变）——需要完整形状时用 `run` 显式重发。
- 源 run 的 `run.started.modelOverride` / `run.started.reasoningOverride` 事实会被**原样继承**到新派发——权威是**首条绑定该 runId 的 `run.started`**（transcript 信封绑定纪律，与 resume 的首条取法同族；尾部追加的伪造 `run.started` 即使形状合法也不采信）。值仍过 `run` 既有的形状门/闭集门与合成入口——新 run 的 `run.started` 落同样的覆盖事实。源 run 无覆盖且未显式给 flag → 零覆盖（与旧输出逐字节一致）。
- **旧格式宽容（R12-C）**：源 transcript 缺 `run.started`（R10 前旧格式）→ retry 按**零覆盖**放行，不拒绝——与 resume 的拒绝语义不同但各自正确（resume 要接续同一会话，找不到事实只能拒绝；retry 是全新派发，零覆盖即注册表策略）。
- `--model <id>` / `--reasoning <effort>` **显式替换**对应继承值（校验与 `run` 同源：模型 id 形状门 + effort 六值闭集 `minimal/low/medium/high/xhigh/max`）；不给 flag 则用继承值。
- **坏持久化值 fail-closed 拒绝**：源 transcript 的覆盖值损坏（非字符串/空/`--` 前缀/含空白/超长、或 effort 集外）时 retry 直接拒绝（固定文案指向源 run，`retry_inherit_model_invalid` / `retry_inherit_reasoning_invalid`，零新 transcript）——绝不静默忽略、绝不静默降级回注册表模型。显式替换 flag **不豁免**坏值拒绝（坏 transcript 事实一律拒绝；flag 形状门先于该检查，两者文案不同）。
- 成功输出在确有继承/替换时携带 advisory 字段 `inheritedOverrides`（`model`/`reasoning` 各带 `value` + `source: "inherited"|"replaced"`；与 effective model 回显同一措辞纪律——展示 WAO 下发了什么，不证明 provider 接受该值）。无覆盖时该字段缺席。
- 想做**无覆盖**重试（回到注册表策略）：不要用 retry——直接 `run` 用原 prompt 重发即可。
- **reuse 形状（诚实口径，R12-C）**：retry 走前台入口，**不解析 sessionReuse 路由**（只有后台派发通道解析）；reuse 形状 agent 的 retry 会以**全新 provider session** 派发（与前台 `run` 同族）——不撞 reuse 互斥门，也不复用旧会话。retry 无 `--require-certified` 入口。

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

> 本区为**手写参考**（不可从代码推导——当前无事件 SSOT；未来 transcript.js 若出现事件 SSOT 可转生成层，届时登记 tech-debt）。内容为契约，修改需过 docs-consistency。
> 本表是 transcript 事件类型的**完整权威定义**（spec 契约见 `docs/02-architecture.md` §3.2）。
> 其它文档（SKILL.md 等）引用事件时指向此处，不维护并行清单（SSOT）。

每个 run 的事件流存在 `runs/<runId>.jsonl`，每行一个 JSON 事件。完整事件类型：

| 事件 | 含义 | 阶段 |
|------|------|------|
| `run.started` | run 创建（含 backend/cwd/model/worktreePath；R10-A 起：带 `--model`/`model` 覆盖的派发另含显式 `modelOverride` 字段，`model` 为合成后策略——只替换 `.id`，兄弟字段保留；R11-1 起：`reasoning` 无条件落盘（agent 无 reasoning 时 JSON 省略该键——顺带补上静态 reasoning 的审计缺口），带 `--reasoning`/`reasoning` 覆盖的派发另含显式 `reasoningOverride` 字段，`reasoning` 为合成后策略——只替换 `.effort`） | M0 |
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
| `run.delivery_verification_failed` | TD-103：delivery 验证失败（含 failureCode）。R17（TD-130 W1）起：事件内 DeliveryRef 的 `verification.results`（与 `setupResults`）每个命令结果新增加性字段 `stdoutTail`/`stderrTail`——**仅非成功结果**（非零退出/超时/launch error）携带内容，各保留尾部 ≤8192 字节原始输出 + 截断标记 `…[truncated N bytes]`（N=丢弃字节数）；成功结果恒为空串（绿输出只计数不落体）。内容类=子进程测试输出（仓内生成），随整包走 transcript append 的 exact-secret 脱敏（字面凭据值会被改写为 `[REDACTED:NAME]`）；MCP `run_delivery` 投影边界不变（`verificationFailureSummary` 仍是 8 键纯标量，不带尾内容） | Phase 3B |
| `run.delivery_verification_unavailable` | TD-103：无验证命令（unavailableReason） | Phase 3B |
| `run.delivery_accepted` | TD-103：Lead 接受——含 updated DeliveryRef + deliveryCommit + reason | Phase 3C-2 |
| `run.delivery_rejected` | TD-103：Lead 拒绝——含 updated DeliveryRef + deliveryCommit + reason | Phase 3C-2 |
| `run.read_only_declared` | Round 4：只读声明（`run_dispatch` 顶层 `readOnly:true` / CLI `run --read-only`）——start 时恰一次的 durable 事实；payload 为空（envelope 即事实，无 prompt/路径/argv），其存在是 `run_activity` 附带 `readOnlyObservation` 观察投影的权威输入，本身不构成任何门 | R4 |
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

# 查询族：registry / runs / wao 的只读子命令（TD-86 起同样支持 --format json）
npm run cli -- registry validate --registry config/agents.json --format json
npm run cli -- registry check --registry config/agents.json --format json
npm run cli -- runs list --format json
npm run cli -- runs summary --format json
npm run cli -- runs grep "error" --format json
npm run cli -- wao decision list --format json
npm run cli -- wao handoff read lead --format json
```

> 本区为**手写参考**（不可从代码推导——形状散在各命令实现中，无单一输出形状 SSOT；未来若出现输出形状 SSOT 可转生成层，届时登记 tech-debt）。内容为契约，修改需过 docs-consistency。

TD-86 起上述 7 个查询子命令的 JSON 输出形状（字段全部来自既有计算结果）：

- `registry validate --format json` → `{checked, valid, agents:[{id, ok, issues[], warnings[]}]}`；JSON 模式维持 exit code 契约（有错误条目 → exit 1，文本模式的 ⚠ warning 进入 `warnings[]`，不阻塞）。registry 源 JSON 解析失败时输出 `{checked:0, valid:false, agents:[], issues:[...]}`——顶层 `issues` 数组保留原始解析错误 message，exit 1。文本模式：角色合同失败的 agent 只输出一行 `✖ <id>`（不先打 ✔ 成功行再打 ✖ 自相矛盾两行）。
- `registry check --format json` → `{allOk, agents:[{id, status:"ok"|"fail"|"skip", serveUrl?, error?}]}`；fail 会照旧 exit 1。
- `runs list --format json` → 直接序列化共享 `listRuns` 服务结果（`{runs:[{runId, agentId, state, terminal, updatedAt, ...}], matchedCount}`），零新计算。
- `runs summary --format json` → `{total, byState, latest}`（无事件时间戳时 `latest:null`）。
- `runs grep <pattern> --format json` → `{pattern, matched, matches:[{runId, type, ts}]}`——与文本路径一致，**每个 run 只记录首个命中事件**（不是全量命中清单）。
- `wao decision list --format json` → `{decisions: string[]}`（map.md 索引行原样包装，不做 id/title 解析）。
- `wao handoff read <role> --format json` → 找到时 `{found:true, role, body}`；未找到时维持既有 `{found:false}`。

LLM 编排器（未来的 M5 DAG 或外部脚本）只需要：
1. `spawn` 启动 run，拿 runId
2. `status <runId>` 轮询状态
3. `collect <runId>` 或读 transcript 拿产出
4. `runs metrics <runId>` 拿成本

### 三席会审记录：`wao stage` panel 字段（决策 0023，advisory 非门禁）

方案（stage 2）与交付物验收（stage 4）可登记会审 panel 记录——三席会审（Lead 主审 + 两名副审）是推荐标准，配不齐则以两席为次之推荐；强烈推荐但非强制，跳过需登记显式理由：

```powershell
# 登记自报副审席位（registry 存在性校验；自报、未验证——评审旁证走 --artifacts 的 runs/<runId>.jsonl）
npm run cli -- wao stage 2 --task "方案定稿" --panel-seats coder_hq,auditor --artifacts docs/plan.md
# 登记跳过理由（闭集码；与 --panel-seats 互斥，非法码 fail-fast）
npm run cli -- wao stage 4 --task "交付验收" --panel-skip-reason low_risk_small_task
# 裸跑查看 panel 分布 + skip 理由分布（pipeline 自省）
npm run cli -- wao stage --cwd <目标项目>
```

- 跳过理由闭集（SSOT：`src/waoStage.js` 的 `PANEL_SKIP_REASONS`）：`no_reviewer_available` / `low_risk_small_task` / `time_critical` / `owner_direct`。细节差异（如 provider 临时不可用）进 `--note`，不扩闭集。
- 其余 stage（1/3/5/6）带 panel 参数 fail-fast（"panel 字段只在方案（2）/交付物验收（4）登记"——不写成"会审仅发生在两节点"，同一 stage 允许多条记录，返工/窄复核照常再登记）。
- stage 2/4 落盘成功且无 panel 字段时输出 JSON 加性字段 `panelAdvisory`（未记录会审提示；exit 0 不变——非门禁）；stage 4 成功输出固定复述红线："评审意见是证据不是验收；`run_delivery_decide` 只由 Lead 调用"。panel 记录写进 STAGE 正文 frontmatter 与 `pipeline/map.md` 索引行第 5 列（无 panel 的旧行照常解析）。
- 会审就绪提示的两张面（数据源不同，勿混）：`wao onboarding` 的分级块**按面切换**（R10-B）——私有 `config/agents.json` 不存在时是**模板面**（从入库模板行 + 当前环境探测推导）；存在且可读（或刚被 `--apply` 写入）时切到**已配置面**（从该 registry 的行 + 同一探测实现推导；标题标注"已配置面"，附"已配置 N 名 worker（真实状态以它为准）——完整体检见 `wao doctor`"指针行；私有 registry 存在但读取失败则降级模板面并标注来源不可读，不阻塞主流程）；`wao doctor` 的 `panel_readiness` 检查恒为**已配置面**——从你的 `config/agents.json` + doctor 既有探测推导，仅当可用席位候选 ≤1 或零对抗席时打印 INFO（三席齐备且含对抗席才静默；registry 缺位沿既有"未配置（跳过）"INFO 模式；不计 DEGRADED、不改退出码）。分级只统计**席位候选**（对抗席 = auditor 专职 / coder_mm 替补；实现席 = coder 系通道；researcher/tester 等调研/工具角色不进席位计数与建议）：三席（≥2 名可用席位候选，推荐标准）/ 两席（恰 1 名，次之推荐，补齐第二副审可升级）/ 无可用席位候选（跳过提示）；≥2 席位候选但 0 对抗席时仍判三席（物理可配）但必附"无对抗席候选（auditor/coder_mm）——建议补配"提示行，doctor 不静默；`login_based`/`unknown` 不计入可用但如实展示（登录态型展示"登录态未验证"，serve 注入型展示"注入式认证（serve 探测不覆盖）"，探测未知展示"探测未知"）；跨族系（推断族系标签，展示专用非契约）是更强推荐。席位角色的判定顺序：显式 `seatRole` 声明优先，省略回退命名惯例（见上文 registry 配置详解）。

### MCP stdio 接口（agent-facing primary，M9）

WAO 是 MCP-first 控制面（Decision 0017）：一个 MCP host（如 Claude Desktop、Codex、OpenCode、其它 agent runtime）可通过 stdio 把 WAO 当作 MCP server 调用。工具计数、参数与形状不在本文维护：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。常用 Lead 闭环为 inventory → workspace_status/select → dispatch → await result → delivery review bundle → acceptance，另有原子 status/wait/collect/activity/diagnose、delivery query/review/reverify、stop/list recovery、Lead 授权修正续跑 run_continue。built-in playbook catalog **不在工具面**——它是按需读取的 MCP resources（`wao://playbooks`，见下文）。`run_await_result` 是 advisory 只读便捷工具：一次调用等待终态（waitMs 0..270000，默认 270000；0 为 point-in-time）后返回安全 compact 终态结果 + 真实 run/liveness 观测，snapshot-only 零 audit，绝不 stop/decide/repackage；非终态时 Lead 可按任意合法 waitMs 再调，所有原子工具（run_wait/run_collect/run_status…）始终可用。`waitMs` 约束工具主动 sleep/poll 的总等待预算，而不是给每个内部阶段各分配一份预算；本地 transcript 文件读取与同步 snapshot 投影不能在 JavaScript 执行中途抢占，极端存储停顿可能让实际墙钟略超预算，工具不把这种环境延迟谎报成 worker 失败。`observationOutcome` 区分干净读取（observed）与 transcript 读失败（read_failure）；读失败时必带闭集机器码 `readFailureReason`（`transcript_parse_failed`=读取/JSON 解析异常、`legacy_event_shape`=历史非可用条目/快照形状不兼容、`snapshot_unavailable`=其他安全非解析类失败；observed 为 null），供 Lead 机器化决策——字段只含闭集码，绝不泄漏错误 message/path/command/credential，unexpected 内部异常仍保持固定 opaque 错误（M12-6 FR-08）。每个 tool 直接调用共享 application service，不 shell-out CLI。当前工具清单权威表见 `SKILL.md` 与 `docs/02-architecture.md`。

**M12-11 统一观察/终止事实**（`run_wait` 与 `run_await_result` 同形附加闭集字段，零 control/语义边界变更）：两者都附带 `observation: { outcome, waitedMs, windowMs }` 与 `termination: null | { state, source, configuredMs, policySource }`。`observation.outcome ∈ { point_in_time, window_expired, terminal, read_failure }` 让 Lead 不再猜测"窗口到期 / 终态 / 读失败"；`termination` **仅在干净观测到终态时非空**——窗口到期/读失败/transport 丢失一律 `null`，绝不折叠成 worker 已停止。`termination.source ∈ { completion, execution_deadline, manual, provider, backend, control_plane, unknown }` 是闭集终止来源（`execution_deadline` 仅当 WAO 截止定时器真触发；provider/backend/control_plane 由诊断 SSOT 投影，不含 raw error/reason/path/command/credential）。所有事实从**同一 snapshot** 派生并绑定 runId，零额外读、零 transcript 追加。`run_wait` 因此获得与 `run_await_result` 一致的 fail-closed 读失败语义（liveness/ownerHeartbeat 为 `unknown`，不拼陈旧事件 + 新鲜心跳）。Transport 恢复：若调用无返回结果，观察状态 unknown，这两个只读工具未做任何 control-plane 变更、未停 worker——point-in-time 重读 `run_await_result(waitMs:0)` 或 `run_status`，**绝不从 transport 丢失推断 worker alive/dead**。

**M12-9 三项机械增强**（均不改 control/语义边界，不新增门禁）：① `run_dispatch` 输入新增可选顶层 `executionProfileId`（与 `delivery` 同级；取自冻结可信 profile catalog，仅提供 delivery 验证的 setup/assertion 命令，与 inline `delivery.verificationCommands`/`delivery.verificationSetupCommands`/`delivery.verificationUnavailableReason` 互斥、仅 delivery 使用、派发前解析；未知/冲突由共享 resolver 稳定拒绝）；② 新增 advisory 只读工具 `run_dispatch_contract_check`（MCP adapter 在它与 `run_dispatch` 间共享输入 schema——service 自身不导入 Zod；service 复用同一 application 校验即共享 resolver + prepareDeliveryRequest，返回闭集 workspace/registry/contract 视图 + 有界 issue 码；`contractValid` 只反映 delivery/profile 机械合同，不预评 `expectedGitHead`/`expectedDirty`/`expectedWorkspaceRoot`、continuable/backend/session 资格或 worker 凭据——非门禁，sections 独立 settle 为 `observed`/`unknown`、`advisory` 恒为 `true`，零副作用，`run_dispatch` 不可依赖它，其部分失败不影响派发；R4 起它与 `run_dispatch` 共享输入 schema，故同样**接受**顶层 `readOnly` 字段但**不评估**它——只读是派发声明，不是 delivery 合同维度）；③ `run_await_result` 在终态且快照干净时附带有界闭集 `outcome`（terminalState / diagnosis(category/code/signalCount) / delivery(requested/readiness/available/failureCode/verificationStatus/verificationFailureCode/acceptanceStatus/decisionType) 安全事实；不含 commit id、changed paths、diff、command 文本、message/stderr、绝对路径或推荐，复用同一 snapshot 一次读取、零额外 transcript/Git 读、零 messages.collected 追加；非终态/read_failure → `outcome` 为 null）。**M12-13 增补**：`outcome.delivery` 追加 `isolationFailureCode`（闭集码或 null）——终端 delivery-requested run 且隔离违反为唯一较高优先级 delivery 事实时投影（见 `run_delivery` readiness `isolation_failed`），与 `deliveryFailure`（packaging 失败）严格分离。

**Host 注册说明**：`npm run mcp` 仅用于在 WAO repo 内手工 smoke；正式 host 注册应指向 Node shim 和 stdio entrypoint 的**绝对路径**，并为 registry 和 runDir 指定绝对路径——MCP host 的启动 cwd 不保证是 WAO repo。host 配置语法由 host 自己负责。注册后若当前会话未发现工具，重启或重载 host。Provider credential 必须由 host 通过其安全 env inheritance/allowlist 提供——不把 credential value 写入 repo、worker prompt 或 MCP args。WAO 不接管 host-global auth。

#### 冻结工具面（always-registered tools，M12-10 progressive-disclosure correction + M12-16 run_correct）

WAO 的 MCP 工具**全部始终注册**：无 profile、无启动 flag、无 restart-to-recover——每个操作工具对连接的整个生命周期都可独立调用。这是一个**静态呈现层**：它**不是**权限层、**不是**路由层、**不按** host/runtime 名分支（Claude/Codex/Kimi/OpenCode 一视同仁，无任何 `if host==…`），也不依赖 `tools/list_changed` 或运行期动态注册。工具面的字节稳定性**分层**（ADR 0021）：`name` 与注册顺序逐字节冻结；`inputSchema`/`outputSchema`/`annotations` 由 description 剥离 SHA-256 冻结契约哈希锁定（仅限 additive 变更 + 显式重冻结记录）；`description` 可修订——受冻结字节天花板约束、每次修订附 Lead 复核记录。演进 additive-first，减面两级程序见 `.wao/decisions/0021`。参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。

原 playbook 工具已**整体移出工具面**（M12-10），built-in playbook catalog 改为按需读取的 MCP resources（`wao://playbooks`，见下文）；M12-16 增 `run_correct`（queued in-flight correction）。全部工具（含 `workspace_select`、`run_dispatch_contract_check`、`run_wait`、`run_correct`）不再被任何子集隐藏，因此一个永不重启的 Host 保留全部操作能力。所有 `DRILLDOWN_TOOLS` 闭集成员（`run_status`/`run_activity`/`run_collect`/`run_delivery`/`run_delivery_review`/`run_diagnose`）均在冻结工具面内，故 `availableDrilldowns` 渐进式披露提示永远只广告可安全调用的观察工具；它只披露、不自动调用、不决策、不广告 mutation/control 工具。

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

`registry_list` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入无参数——`registryPath`/`runDir` 是 server 启动配置，模型每次调用不能覆盖。输出为 MCP `content`（text = JSON）+ `structuredContent`（同义对象）。

`agents` 元素语义与 CLI `registry list --format json` 的数组元素一致（MCP 仅多一层 `agents` 包装）。`registry_list` 是只读操作，调用前后 runDir 不会有新增 transcript/run 文件。

**TD-111 certification advisory context**：每个 agent 额外携带两个 advisory 字段——`certificationReasonCode`（闭集机器码，解释"为什么不是 certified"：`case_blocked`（外部 blocker：provider/credential/quota，或显式 blocked）/ `core_checks_failed` / `strict_evidence_failed` / `operational_or_observability_failed` / `missing_certification_checks`，分支优先级与 reliability 认定一致，blocked 优先于 core 失败）与 `certificationLastHealthyAt`（该 worker 最近一次全绿 case 的 bounded ISO-8601 UTC 时间戳，认证新鲜度）。两字段在 `certified`、无 summary 记录、identity（backend/modelId）变更后认证不可继承、以及旧格式 summary（缺字段）时均为 `null`——**不伪造**。闭集唯一权威在 `src/application/certificationReasons.js`（MCP schema enum 从它派生，无第二份清单）；worker 级 `reasonCode` 取"决定最终（最差）status 的 case"的码，`lastHealthyRunAt` 聚合 active identity 各 case 的最近全绿时间（旧 identity 的全绿不计入）。两字段只含闭集码/日期——blockerReason 原文、路径、命令、stderr 绝不进任何 wire 输出（磁盘 summary 里的自由文本 `reason` 是另一层契约，保持不变）。

**M12-25 bounded partial inventory（Outcome 1）**：MCP `registry_list`（与 `lead_preflight`）走一条**独立的部分投影**路径——registry 源可读但某条目无法 normalize/project 时，**有效 worker 照常返回**，另附有界安全的逐条 `issues` 而非整表失败。`issues` 元素形状固定为 `{ "code": "invalid_id" | "invalid_configuration", "agentId": "<canonical id>" | null }`：`code` 是闭集（`invalid_id`=id 非 canonical；`invalid_configuration`=canonical id 但 backend/cwd/model/provider/sessionReuse/waitTimeout/systemPrompt 校验失败），`agentId` 仅当 id 为 canonical 时投影、否则 `null`（**绝不**回显原始 id）。**绝不**携带原始 error 文本、配置、路径或凭据值；条目数上限 32（`REGISTRY_ISSUES_CAP`），超限设 `issuesTruncated:true`（真实 malformed 数无界）。零有效 worker **但有 issues** ≠ 观察干净的空 registry（`issues` 非空）。这与严格的 registry 维护路径（CLI `registry validate` / `registry list` 仍遇首条坏条目即抛错）是**分开**的投影：WAO 不据此自动停止派发、不自动换 worker、不把坏条目标记为 healthy。整表源不可读或非法 JSON 是**另一类**失败——`registry_list` 直接返回固定 error（`lead_preflight` 则 `checkStatus.workers:"unknown"`、`workers:null`），绝不伪造成部分结果。registry 源每次 MCP 操作**只读/解析一次**；`lead_preflight` 复用同一快照结果，绝不回退二次读取。

**M11-7 凭据可用性**：`certification` 是历史可靠性认证结果，不等于"此刻可启动"。`credentialAvailability`（`available` / `missing` / `not_required`）只反映 worker **registry 显式声明为必需**的 credential（`provider.apiKeyEnv` / legacy `--api-key-env`）是否在当前环境可用——不声称 runtime 整体健康。优先 `process.env`，回退 Windows Current-User 环境，两处都缺失则为 `missing`；未声明必需凭据的 worker 为 `not_required`。**可选继承变量**（如 `OPENAI_BASE_URL`、`CODEX_HOME`、`KIMI_MODEL_NAME`）会被继承但不参与 missing gate——不会因缺少可选配置阻止派发。`missingCredentialEnvNames` 列出缺失的必需 env 变量**名**（绝不包含值）。`run_dispatch` 在 transcript 写入和 fork 前用同一 readiness 检查拒绝 `missing` 的 worker（零 transcript、零 fork），返回固定可行动错误。WAO 不保存/轮换凭据，不批量导入用户环境，只读取 registry 明确声明的精确变量名；设置或轮换凭据后**无需重启 Host**（每次评估重新观察当前状态）。

**M12-6 FR-02 provider readiness 真相（truth）**：`providerReadiness` 是严格投影对象，字段含义：
- `configurationStatus`（恒为 `"configured"`）——只证明该 registry 条目已配置，**不等于** worker 可运行；
- `authenticationStatus` / `entitlementStatus`（恒为 `"unknown"`）——本次 inventory **没有做任何 provider 探测**，因此**永远不得**宣称已认证/已授权；
- `liveCheckStatus`（恒为 `"not_checked"`）——本次调用**没有做 live check**；
- `credentialAvailability`——同 M11-7 语义，只证明必需凭据 env 名存在（或无需凭据）。

这也意味着 `complete:true`、`certified`、`credentialAvailability:"available"/"not_required"` 与 WAO 控制面工具可用，都**不能**证明当前 provider 仍有 quota 或未触发 rate limit。它们是配置/历史/本地观察事实；实时容量只在实际 run 的终态错误中形成事实。

**语义铁律**：preflight/registry 查询"完成"只表示机械事实（registry 可读、必需凭据 env 名存在/不存在、配置条目存在）可读，**不是** authenticated/entitled/live-checked 的证明。本包不做 provider 网络请求、不读凭据值，所以结构上不可能投影出 `authenticated` / `entitled` / `checked`——MCP schema 的枚举直接派生自这些闭集常量（`src/application/registryInventory.js` 的 `CONFIGURATION_STATUSES` / `AUTHENTICATION_STATUSES` / `ENTITLEMENT_STATUSES` / `LIVE_CHECK_STATUSES`），不存在第二份手工维护列表。真实认证/授权状态只能来自实际运行/诊断（见 `run_diagnose` 的 `code`）。

### MCP `run_dispatch`（supervised background dispatch，M9-2B）

`run_dispatch` 让 MCP host 正式派发一个受监督的后台任务。它直接复用与 CLI `run --background` 相同的 application service（`dispatchRun()`），不 shell-out CLI。WAO 拥有 dispatch、detached runner 和 transcript；模型只提供 worker 和 bounded prompt。

**M11-5 角色合同自动注入（TD-89 修复）**：Lead 只需写具体任务 prompt，无需复制角色说明，也无需切换到 WAO 仓库目录。WAO 根据 registry 中 agent 声明的 `systemPrompt`（指向 `config/roles/*.md` 角色契约），用共享加载器（`roleContract.js`）验证并以 runtime-native 方式恰好一次注入 worker——claude-code 用 `--append-system-prompt <内容>`，codex 用 `-c developer_instructions`，kimi-code 用固定分隔组合 role+task，OpenCode 1.18+ 用 message API 原生 `system` 字段且 task 仍只在 user text part 出现一次。**路径权威**：相对 `systemPrompt` 由加载器相对 WAO 安装根解析（不依赖调用者 cwd），所以从 Life Index 等外部项目目录调用也能找到全局角色文件。是否支持注入由 backend 能力声明（`supportsRoleContract === true`）严格判定；能力值非严格 true 时，配了 `systemPrompt` 会在 start（创建 transcript 前）/ resume（读取既有 transcript 后、append/spawn 前）fail-closed。**WAO 不把角色合同保存为 `prompt.sent`/控制面输入**——transcript 只持久化原始 task prompt（注意：worker 输出可能在回答中引用或复述角色，这由模型决定）。Lead/model 不能通过 `run_dispatch` 覆盖角色（strict schema 不接受 `systemPrompt`/`roleContract`/`rolePath`）。

**Kimi K3 模型策略**：registry 用结构化 `model.id` 与 `reasoning.effort` 表达每个 worker 的模型策略。`kimi-code/k3` 的 `low` / `high` / `max` effort 由 backend 编译为仅对子进程生效的 `KIMI_MODEL_THINKING_EFFORT`；WAO 不修改全局 Kimi 配置，也不接受同名 `agent.env` 作为第二权威。K3 的上下文上限来自 Kimi Code 模型目录（当前为 1M），不是 WAO 的进程级 override，因此 registry 不重复声明 `model.contextWindow`。

`run_dispatch` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入是 strict schema（拒绝额外字段）；schema 未列的一切（`registryPath`、`runDir`、`runId`、`cwd`、`workspaceRoot`、`requireCertified`、timeout、`isolate` 等）都是 server-owned 配置，模型不能传。

M9-7A 起支持可选 `delivery` 块（嵌套形状以 wire 为权威），用于派发后续可由 `run_delivery`/`run_delivery_decide` 操作的 delivery run：

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

`delivery` 可选。`verificationCommands` 与 `verificationUnavailableReason` 二选一（互斥）。WAO 强制 persistent worktree isolation——模型不能传 `isolate`（隔离不是可选输入）。registry certification 是 **advisory 证据，不是 permission gate**：`registry_list` / `lead_preflight` 把每个 worker 的 `certification` 状态报告给 Lead，MCP dispatch/continuation 以 `requireCertified: false` 调 shared service，**不**强制认证——没有 reliability-summary.json 的 Fresh 克隆同样可派发（lead_preflight 已报告 configured/credential 事实，认证仅作参考）。显式 CLI `--require-certified` 与 RunManager 的 opt-in 认证门保持完整——CLI 或项目治理仍可要求认证。

**M12-13 per-command 执行预算（可选，`verificationTimeoutMs`）**：Lead 可选为 delivery 声明**单条 verification 命令的执行超时/预算**（整数 ms，共享闭界 `[1000, 7200000]`，默认 300000 **仅在字段缺失时**应用）。这不是 `run_wait` / `run_await_result` 的观察窗口——它约束 exact verifier 的逐条 setup/assertion 命令执行。语义：
- **验证先于副作用**：非法值（字符串/小数/越界）在派发/start/resume 的任何 transcript append、worktree 创建、spawn/attach、打包、验证之前经 `prepareDeliveryRequest` SSOT 拒绝（`invalid_verification`），零转录、零 worktree、零 spawn；
- **零漂移**：仅在显式声明时持久化（`run.started.delivery.verificationTimeoutMs`、`delivery_created` ref、verification outcome ref 都保留该值）；未声明则任何事件/ref 都不出现该字段，消费者才用默认值；
- **持久值权威**：贯穿 start / resume（resume 重新经 SSOT 校验，持久值损坏则 resume 直接拒绝 null，零副作用）、profile 折叠（profile 只供命令，Lead 声明的预算保留）、MCP/CLI 转发、`run_dispatch_contract_check` advisory 校验、`run_delivery_repackage` 原值重建与 verifier 调用、reverify 继承（省略 `timeoutMs` 时继承 ref 上持久化的预算，持久值损坏则 fail closed；显式值同样必须落在共享闭界内）；repackage 中字段缺失仍交给 verifier 默认值，字段存在但损坏则在 inventory/Git/transcript/verify 前拒绝；
- **无自动动作**：从不自动加宽、从不重试、从不因超时自动 stop/decision——超时结果如实投影为闭集 `command_timeout` / `setup_timeout`。

**M12-7 continuable 续谱根（delivery-only 可选）**：`run_dispatch` 顶层可带 `"continuable": true`（与 `delivery` 同级，不在 delivery 块内），把这次 delivery 标记为一条**可续谱系（continuable lineage）的根**。dispatch 会以 `run_lineage` / `turn:first` 建立一个 provider-native 会话（opaque uuid 由 server-owned Lead session + canonical workspace + canonical agentId + 该 run 的 rootRunId 派生），保留 retained worktree。这样日后 Lead 若审阅该终态 delivery、发现窄缺陷，可用 `run_continue` 对其续 ONE 修正回合——复用同一 retained worktree、以 `turn:resume` 续同一 provider 会话（同一 opaque uuid）。`continuable` 默认 `false`，省略时与普通 delivery dispatch 字节兼容；`continuable:true` 必须配 `delivery`（service 强制 delivery-only，否则 fail-closed）。WAO 从不在 dispatch 时推断或触发任何续跑/修正——是否续跑完全由 Lead 事后显式调用 `run_continue` 决定。

**R4 只读声明（可选，`readOnly`）**：`run_dispatch` 顶层可带 `"readOnly": true`（CLI 等价 `run --read-only`），把这次 run 声明为**只读**。声明链路是"声明 → 强制隔离 → 观察"：`readOnly` 强制 persistent worktree 隔离（worktree 创建失败时 fail-closed 拒绝派发——typed `read_only_worktree_required`，**不走**普通 run 的降级原 cwd 路径），start 时恰一次写入 `run.read_only_declared` durable 事实（见 §三事件表），之后 `run_activity` 在快照含该声明时附带 advisory `readOnlyObservation`（见 `run_activity` 节）。`readOnly` 与 `delivery` 块互斥（固定拒绝文案携带闭集理由码 `read_only_delivery_conflict`；CLI 侧 `--read-only` × `--delivery-spec-file` 同样拒绝）；与 `correctable` 可共存（correction 是 Lead 显式指令，声明与观察并存）；`readOnly` × `continuable` 被既有 delivery-only 门自然拒绝。**诚实上限（三句）**：① 观察基于 worker 工具上报的 `file_written` 证据（`no_writes_observed` 的含义是"未观察到写"，**不是**"没写"），不是全知监控；② 强制隔离与越界侦测是**侦测机制**，不是 OS 沙箱——隔离降低误写面，但不能物理阻止越界写；③ 观察是 **advisory 非门**——观察到越界写不会自动停止、不会失败、不改写 run 的自然终态，终审归 Lead。另注意与 `wao ask` 的 prompt 级只读边界（快捷派工默认注入的只读提示词）区分：那是**不可验证、无持久事实**的 prompt 约定；控制面 `readOnly` 声明则有 durable 事实事件 + 基于上报证据的观察投影。

**R10-A 单次模型覆盖（可选，`model`）**：`run_dispatch` 顶层可带 `model`（`"model": "<modelId>"`，CLI 等价 `run --model`，完整语义见 §二场景 1b）——单次生效、不落注册表、只替换注册表 model 的 `.id`（contextWindow/providerID/variant 保留），wire schema 与核心校验器同源（非空、≤128、不以 `--` 开头、无空白/控制字符）。互斥与放行：× provider-session 复用（reusable expert / continuable 谱系根）以固定文案拒绝（闭集码 `model_override_reuse_conflict`——"A per-dispatch model override cannot be combined with provider-session reuse … must run one model"）；认证互斥（closed-set `model_override_certified_conflict`）在 MCP 侧不可达——`requireCertified` 恒为 server-owned `false`，认证矩阵（provider+model 组合的 certified 记录）只在 CLI 显式 `--require-certified` 时被求值；× `delivery` 块放行，但**该 run 的认证组合声明失效**（认证按注册表 provider+model 组合记录，覆盖后的组合未经认证）——override 事实由 `run.started.modelOverride` 入 transcript 供审计。派发成功不回显 effective model（MCP 输出 schema 冻结为闭集字段）；打错的模型名要到 provider 期才报错，需即时确认时读 transcript 的 `run.started.model`。

**R11-1 单次推理力度覆盖（可选，`reasoning`）**：`run_dispatch` 顶层可带 `reasoning`（`"reasoning": "minimal"|"low"|"medium"|"high"|"xhigh"|"max"`，CLI 等价 `run --reasoning`，完整语义见 §二场景 1c）——单次生效、不落注册表、只替换注册表 reasoning 的 `.effort`，与 `model` 参数可同用（Owner 场景 "gpt-5.6-sol + xhigh"）。wire schema 直接序列化闭集枚举（`registry.js` 的 `REASONING_EFFORTS` SSOT 经 runDispatch 下向 re-export——zod enum，比正则更严，与核心校验器零漂移）。互斥与放行：× provider-session 复用以固定文案拒绝（闭集码 `reasoning_override_reuse_conflict`——"A per-dispatch reasoning effort override cannot be combined with provider-session reuse … must run one reasoning effort"）；认证互斥在 MCP 侧不可达（同 `model` 的 server-owned `false` 构造）；× `delivery` 块放行。不可表达（opencode-serve）与条件不支持（kimi K3-only、dsh high|max）组合走既有 per-backend policy 门自然拒绝。**`run_dispatch_contract_check` 共享该输入 schema 但有意忽略 `reasoning`**（它只就 delivery 合同给 advisory——与对 `model` 的忽略同一先例）。派发成功不回显 effective reasoning（MCP 输出 schema 冻结）；需即时确认时读 transcript 的 `run.started.reasoning`。

**verification 环境合同（M12-6 FR-05/FR-06）**：Lead 可选声明 `verificationSetupCommands: string[]`——在 assertion 命令（`verificationCommands`）之前顺序执行的"环境准备命令"（如 `npm ci` 安装依赖、生成构建产物）。setup 与 assertion 分开验证、持久化与投影：setup 失败投影为闭集 `setup_failed` / `setup_timeout` / `setup_environment_error`，**绝不**伪装成 assertion 的 `command_failed`，不泄漏命令体/路径/stderr。每条 setup 与每条 assertion 之后都重做 exact delivery commit / 受跟踪工件证明，任何 tracked artifact 或 lockfile 漂移 = `artifact_mutated`（setup 漂移时 assertion 不执行）。exact-artifact verifier 运行在**独立的 per-attempt 临时环境**：每次 setup / assertion 命令各创建唯一 temp 目录并注入 `TMP` / `TEMP` / `TMPDIR`，两个 attempt 不复用、不复用 worker temp，仅持久化安全布尔事实（不含绝对路径）。**依赖不继承**：selected / worker worktree 的 `node_modules` 等 ignored / untracked 依赖**不会**自动出现在 exact verifier 环境——需要 Lead 声明 `verificationSetupCommands` 来准备。

**Workspace binding（M10-pre2 + M11-6）**：`run_dispatch` 在调用 shared service 前**重新解析并证明** workspace（优先级：Lead 会话选择 `workspace_select`（`lead_session`）> MCP client roots/list 恰好一个合法 `file://` root（`mcp_root`）> 显式 `--workspace-root`（`server_config`）> 否则 fail-closed）。证明后的 canonical Git root 作为 `cwd` 传给 dispatcher。workspace 未绑定时 dispatcher 不会被调用（零 transcript、零 fork），返回固定安全文案。**M11-6**：Lead 可在当前会话用 `workspace_select` 选择 Git 项目（最高优先级），无需 Human Owner bind、无需项目配置、无需重启——失败选择不影响既有会话状态，也不写任何持久配置。

- **输出**（成功或拒绝同形，MCP `content` + `structuredContent`）：字段清单见生成层。**身份绑定（M11-8B final）**：返回的 `agentId`（transcript envelope 盖戳的 canonical worker 身份）必须精确等于请求的 `agentId`——这是控制面对派发的身份绑定，不允许"合法但属于另一个 worker"的 id、missing/unknown/非法值；mismatch 一律折叠为固定 `run_dispatch failed`（`isError:true`、无 `structuredContent`、不泄漏返回值）。`run_dispatch` 永不返回 `"unknown"` 哨兵（那是 read 类工具的降级值）。不返回绝对路径、PID、prompt、argv 或内部错误。service 失败时返回固定安全文案 `run_dispatch failed`，不拼接原始 exception message、stderr、路径或凭据。

**M12-25 provider session routing truth（Outcome 2）**：`providerSessionRouting` 是闭集 `"not_used" | "first_turn_requested" | "resume_requested"`，描述**本次派发的路由请求**真相，**不是** provider 会话成功/建立的证明。派生仅来自 `dispatchRun` 内部已选定的路由回合（`routing.turn`）：普通一次性派发（含普通 delivery 的 `lead_workspace` 复用，该复用是**有意不使用** provider session）→ `not_used`；reusable expert 首轮 / continuable delivery 根首轮 → `first_turn_requested`；reusable expert resume / continuable 续接 → `resume_requested`。`accepted:false` 早返回恒为 `not_used`。**绝不**暴露 routing mode、opaque session uuid、Lead id、workspace path、argv 或 provider payload——这些是 server-owned 内部细节。该字段只如实说"请求了什么路由"，provider 是否真正 resume 成功仍由后续 `run_status`/`run_await_result` 的传输与终态证据决定；WAO 不据此自动决定路由、不自动重试、不自动 stop。

**行为变更（R14 / TD-128a，reuse 路由）**：reuse 路由对前任 run 的 `session.created` 存在性检查（决定 busy/resume/first 分派）自 R14 起为 **runId 绑定读取**（绑定到前任 runId）——尾部追加的外 run 伪造 `session.created` 不再能把一个 crashed-pre-conversation 的前任 run 翻转成 resumable。由此，**前任 run 的 transcript 为信封前 legacy 格式（事件无 `runId` 字段）时，reuse 路由从 resume 降级为 first**（走既有"terminal 无 session.created"分支，认领槽位开新回合）——不复用无法归属到前任 run 的会话；本机 pre-envelope transcript 存量为 0（TD-129b 实测），实际影响 ≈0。

**行为变更（R15，reuse/lineage 路由的 findState）**：reuse 与 lineage 路由对前任 run 终态的判定（`findState`）自 R15 起同样为 **runId 绑定过滤**（状态只由前任自身事件计算）——尾部追加的外 run 伪造 `run.state_change` 不再能把在飞前任翻成 resume（并发驱动同一 provider 会话，Contract 6）或把终态前任伪造成在飞而阻断派发。全无信封的前任 transcript（零绑定事件）按 **busy** 处理（不可归属 = 永不并发驱动；实测存量 ≈0）。

返回时 transcript 已可读且为 `pending`；关闭 MCP host 后，detached runner 独立驱动 worker 到终态（token 闸门/超时/兜底 abort 都生效），写入共享 transcript。Lead 用 MCP `run_status` 轮询状态。

### MCP `run_continue`（Lead 授权修正续跑，M12-7）

`run_continue` 让 Lead 对一个**终态 continuable delivery** 续 ONE 修正回合。典型场景：Lead 审阅一个 delivery、发现窄缺陷（如一个漏改的边界条件），显式授权一次修正——WAO 创建**新** run/transcript，**复用父 run 的 retained worktree**（不开新 worktree、不开新 provider 会话），以 `turn:resume` 续同一 provider-native 对话，并打包新的 child delivery。MCP adapter 直接委托 application service `continueRun()`，不 shell-out CLI；M12-7 没有新增 CLI 子命令。

**Lead 语义唯一，WAO 不推断**：correction 的存在、范围、verification、retry、acceptance 全部由 Lead 决定——`run_continue` 只在 Lead 显式调用时发生一次，从不自动续跑、从不扩大范围、从不自动重试/接受/拒绝。child delivery 的 review/accept/reject 仍走 `run_delivery_review` / `run_delivery_review_bundle` / `run_delivery_decide`，归 Lead。

**续谱作用域（非 project-wide coder 复用）**：复用的是**这一条谱系**的 provider 会话——opaque uuid 由 server-owned Lead session + canonical workspace + canonical agentId + **root runId** 派生，跨一条 lineage 复用。它与 M11-11C 的 `lead_workspace` expert 复用是不同的 routing 模式（`run_lineage` vs `lead_workspace`），互斥：`continuable` 是 delivery-only，`lead_workspace` 是非 delivery。

`run_continue` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入是 strict schema：`parentRunId` + `prompt` + **必填**的子 `delivery` 块（嵌套形状以 wire 为权威）。

`parentRunId` 必须是一个**终态**且 `continuable` 的父 run（其 `run_dispatch` 顶层带了 `continuable:true`）。已 accepted 的父 delivery 不可续；Lead 应为已接收成果另建新 run。`delivery` 必填（续跑总是 delivery run，child 会从谱系原始 baseCommit 打包累计 candidate，而不是只打包本轮 correction delta）。因此 child 的 `allowedPaths` 必须**覆盖父 retained 成果的全部累计 changed paths**（父成果 + 本轮修正）；WAO 不会替 Lead 推断或扩展范围。**M12-22 累计范围真相**：这一覆盖关系在 read-only 资格阶段即被核对——`run_continue` 从权威 Git/worktree 事实派生父 retained worktree 中**仍存在**的实际变更，复用既有 containment SSOT（`isPathAllowed`，segment-boundary 语义）与既有 inventory 上限，在任何 mutation 之前与 child `allowedPaths` 比对。若存在未被覆盖的继承路径，`run_continue` 以 `continuation_scope_incomplete` 拒绝，并返回**有界的仓库相对事实**（`inheritedChangedPaths` / `inheritedChangedCount` / `inheritedChangedTruncated` 与 `uncoveredInheritedPaths` / `uncoveredInheritedCount` / `uncoveredInheritedTruncated`，已排序去重、按既有 inventory cap 截断），供 Lead 显式批准累计范围后重试。WAO 绝不自动扩展范围、自动恢复文件、重试或接受，也不暴露绝对路径、prompt、command、provider/session 数据或任意 Git 错误。一个被授权用于 correction 的路径随后可被 restore 回 base 并从最终 delivery 中消失——WAO 不解读该语义选择；child 自身最终 diff 仍由既有 packaging containment 闸门（`disallowed_path`）治理，本检查**未削弱** packaging。模型不能传 workspace/registry/runDir/cert——这些 server-owned，由 MCP 边界从绑定 workspace 解析。

- **资格检查（read-only，先于任何 mutation）**：WAO 在 claim 续谱槽 / 转换 worktree / 写 transcript / fork 之前，以 closed-set `rejectionReason` 拒绝不合格的续跑：`malformed_input` / `invalid_delivery` / `parent_not_found` / `parent_not_terminal` / `parent_accepted` / `not_continuable`（父 run 非 lineage 续谱根，legacy 不可续）/ `no_provider_session` / `workspace_mismatch`（父 run 不属于当前绑定 workspace）/ `no_delivery`（父 run 缺 delivery 上下文）/ `worker_configuration_changed`（当前 backend/model 已不同，不能继承旧 provider session）/ `unsupported_backend`（backend 未声明 session reuse）/ `missing_worktree` / `worktree_drift`（retained worktree 丢失或 base/分支漂移）/ `continuation_scope_incomplete`（M12-22：child `allowedPaths` 未覆盖父 retained 累计变更——retained-worktree 证明之后、claim 续谱槽之前的 read-only 阶段即返回有界 inherited/uncovered 事实，零 side effect，不自动扩展范围）/ `busy`（同一谱系已有非终态 owner 在跑）。静态 argv 与 credential 检查也在 mutation 前完成；开始转换后若 transcript 或同步 spawn 失败，WAO 机械恢复父 worktree、删除 orphan child transcript 并释放谱系 claim。第二次 worktree 证明若发现外部漂移，只报告事实，不覆盖外部状态。这些 closed-set refusal 是**正常结构化结果**（`accepted:false` + `rejectionReason`），不是 MCP error；环境/内部执行错误仍保持既有固定安全错误边界。

- **输出**（成功 / 拒绝同形，MCP `content` + `structuredContent`）：字段清单见生成层。成功返回新 child 的 dispatch 身份 + 谱系事实（`parentRunId` + `continuation:true` + `rootRunId`）。拒绝时 `accepted:false`、`rejectionReason` 为闭集码、其余成功字段为 `null`；`continuation_scope_incomplete`（M12-22 累计范围未覆盖）是唯一额外携带累计范围事实的拒绝形状，供 Lead 显式批准后重试（见下）。**`busy` 只回 label，不回 active runId**——opaque provider uuid、Lead id、workspace 路径、active lineage runId、transcript 路径**永不**出现在 MCP 输出（与 `run_dispatch` reuse-busy 脱敏合同一致）。`continuation_scope_incomplete` 是唯一携带累计范围事实（`inheritedChangedPaths`/`inheritedChangedCount`/`inheritedChangedTruncated` 与 `uncoveredInheritedPaths`/`uncoveredInheritedCount`/`uncoveredInheritedTruncated`）的拒绝码——这些有界仓库相对字段仅在 `continuation_scope_incomplete` 拒绝中出现，成功与其余拒绝均不携带；任何畸形/不安全路径在该字段投射时 fail closed 为整体省略（闭集 reason 仍保留），绝不泄漏绝对路径或 Git 错误。

- **retained-worktree 转换（幂等、崩溃安全）**：把父的 retained worktree 重新钉到 base 上、切到 child 分支 `wao/<childRunId>`，把父的 delivery/candidate 字节保留为 unstaged 工作改动；**父 commit 对象永不删除**，仍可按 SHA 审阅。child 从 base 打包自己的 delivery。

workspace-bound：父 run 必须属于当前绑定 workspace，否则 `workspace_mismatch`。

### MCP `run_correct`（运行中显式纠正，M12-16）

`run_correct` 让 Lead 对一条仍在执行、且派发时显式声明 `correctable:true` 的 run 发送一条**有界纠正消息**。它与 `run_continue` 不同：`run_correct` 不创建 child run、不切换 worktree、不重新派发 worker，而是把 Lead 明确提供的纠正写入原 run 的 durable transcript 队列，再由原 runner 串行投递给同一 provider 进程。普通 `run_dispatch` 省略 `correctable` 时保持原行为；backend 未声明 in-flight correction 能力时，`correctable:true` 在创建 run 前 fail closed。

输入是严格对象：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。`correctionId` 为 1..64 字符的 `[A-Za-z0-9_-]` 幂等键，`prompt` 为 1..15000 字符。相同 `correctionId` + 相同 prompt 可安全重查；同一 id 配不同 prompt 固定拒绝。工具只接受 workspace-bound、处于 submitted/running 阶段的 run；pending 尚未可投递，终态 run、未 opt-in run、跨 workspace run 或不支持的 backend 均返回闭集拒绝事实，不自动 retry、stop、continue 或改状态。

输出 `outcome` 是 `queued | pending | delivered | rejected` 的闭集。语义必须逐层区分：

- `queued` 只证明纠正已 durable append，等待 runner claim；
- `pending` 表示已有请求但尚无可确认的最终投递事实；
- `delivered` 只证明字节已送入 provider stdin，**不证明模型已读取、理解或执行**；
- `rejected` 携带闭集 `reason`，不回显 prompt、provider payload、session、路径或内部错误。

runner 以 requested → claimed → delivered/delivery_failed 的 durable 事件链串行处理；`run_activity` 只暴露安全的 correction 生命周期状态，不返回纠正正文。WAO 不判断纠正内容是否合理，也不会据此扩大 `allowedPaths`、改 verification、自动停止或接受交付；这些语义和最终决策仍完全属于 Lead。

### MCP `workspace_status`（workspace binding 状态查询，M10-pre2 + M11-6）

`workspace_status` 查询当前 workspace 绑定状态。`run_dispatch` 在执行前**自行重新证明** workspace，不信任此工具的先前结果。

`workspace_status` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入是 strict empty schema（拒绝任何字段）。

`source` 的三个取值对应三种 workspace authority：`"lead_session"`（Lead 会话选择）、`"mcp_root"`（client roots/list）、`"server_config"`（显式 `--workspace-root`）。`workspaceRoot` 是当前绑定的 canonical Git 顶层绝对路径（Lead/host 已显式提交，非 credential，故返回）；`bound=false` 时其余字段均为 `null`。

**M12-19 unboundReason（recovery truth，闭集）**：未绑定时 `unboundReason` 是闭集恢复事实（恒为 `null`，当已绑定）：`"lead_session_git_proof_failed"`（既有 Lead 会话选择的 Git proof 现在失败，如 repo 被删除——**不**回退到更低优先级 authority）、`"server_config_git_proof_failed"`（显式 `--workspace-root` 的 proof 失败）或 `"no_workspace_authority"`（无可用 workspace authority；mcp_root 失败折叠于此）。只区分"哪个 authority 的证明失败"，**绝不**返回路径或动态错误。失败返回固定安全文案 `workspace_status failed`。

### MCP `workspace_select`（Lead 会话级工作区选择，M11-6）

`workspace_select` 让 Lead 在当前 MCP 会话中选择工作 Git 项目（`lead_session` 来源，最高优先级）。**会话级**：只作用于当前 `createWaoMcpServer` 实例，两个 server 实例状态严格隔离；不写磁盘、不写 `.codex/config.toml`、不写 transcript、不创建 run/worktree/process，无需 host bind 或重启。验证委托 `proveWorkspace` SSOT——只接受 canonical Git 顶层（拒绝 relative/nonexistent/non-Git/subdirectory）。**失败选择不影响既有有效选择**（只在成功时更新）。幂等：重复选同一 repo 是 no-op。

`workspace_select` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入 `workspaceRoot` 必须为非空绝对路径（≤1024 字符）。

失败返回固定安全文案 `workspace_select failed: workspaceRoot must be a canonical Git top-level directory`（不回显传入路径、stderr 或异常 message）。

典型 Lead 流程：`workspace_status`（未绑定）→ `workspace_select(<current Git root>)` → `workspace_status`（确认 `lead_session`）→ `run_dispatch`。

### MCP `lead_preflight`（advisory 单调用启动检查，M11-8A）

`lead_preflight` 让 Lead 一次调用完成 workspace 选择/确认 + worker credential 可用性 + active-run 查询，替代机械地依次调用 `workspace_select`/`workspace_status` + `registry_list` + `runs_list`。**ADVISORY ONLY，不是 gate**：每项检查独立结算（一项失败不吞其他），输出是事实供 Lead 判断，绝不自动中止——不产生 permit/token/approval 状态，`run_dispatch`/`workspace_select`/`registry_list`/`runs_list` 不依赖它曾成功。`complete` 仅表示机械事实（registry 可读、必需凭据 env 名存在/不存在、active run 可数）是否可读取，**不是** authenticated/entitled/live-checked 的证明，也不是"是否应派发"的裁定——M12-6 FR-02：preflight 完成永不意味着任何 worker 已被认证/授权/做过 live check（每个 worker 的 `providerReadiness` 恒为 unknown/not_checked）。

`lead_preflight` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入 `workspaceRoot` 可选；提供时复用 `workspace_select` 的 workspace authority SSOT（`lead_session`），失败不覆盖既有有效选择。省略时只检查当前 session selection。输出是安全投影，不含绝对路径/credential value/prompt/command/PID/session。

不返回 `PASS`/`FAIL`；check-level 状态为 `observed`/`warning`/`unknown`。`manualChecks` 指向原始 MCP 工具，允许 Lead 独立复核（与聚合结论不同时，Lead 可依据直接证据继续并记录 friction）。Active run、conditional worker、dirty workspace 只是事实，不自动禁止派发。

**M12-25 registry partial truth**：`registryIssues`/`registryIssuesTruncated` 复用与 `registry_list` 同一闭集 issue 形状与同一快照（见上文 §`registry_list` 的 M12-25 段）。`registryIssues` 非空时 `checkStatus.workers` 升为 `"warning"`（从而使 `complete:false`）并追加一条计数 warning，但**有效 worker 照常返回**——一条坏条目绝不隐藏其余 healthy worker；Lead 可据 `registry_list` 查看有界逐条 issue。registry 整源不可读时 `workers` 为 `null`、`checkStatus.workers:"unknown"`、`registryIssues:[]`（unknown 绝不伪造为"零坏条目"）。

**M12-19 recovery truth**：未绑定时 `workspace.unboundReason` 与 `workspace_status` 同一闭集（`lead_session_git_proof_failed` / `server_config_git_proof_failed` / `no_workspace_authority`，已绑定恒为 `null`）——让 Lead 在单次 preflight 内直接看到"哪个 authority 的证明失败"，绝不返回路径或动态错误。

**M12-15 stale active-run truth**：`activeRuns`/`activeRunCount` 只计**经证明 active** 的 run——即 transcript 为已知非终态**且**有 fresh owner heartbeat（`ownerLiveness` SSOT，默认 10s 阈值）。一个非终态但缺少 fresh heartbeat 的 run（例如历史 6 月的 stale transcript）**不算** active，但也**绝不**据此推断它 failed/dead/stopped——它仍可能在长时间运行/休眠。这类 run 计入 `unresolvedRunCount`（与 `activeRuns` 同一次扫描/快照，Lead 无需重新扫描），并在 `unresolvedRunCount > 0` 时追加一条 advisory observation（说明这些 run 被排除出 `activeRuns`、不证明失败或停止，请用 `runs_list` 独立查看）。因此 `activeRunCount=0` 永远不应被误读为"工作区干净"——当 `unresolvedRunCount > 0` 时尤其如此。active-run 查询不可读时 `activeRuns`/`activeRunCount`/`unresolvedRunCount` 均为 `null`（unknown，绝不伪造为 0）。

### 项目级 Workspace Activation（M10 P0-1，**可选** Human Owner ops 命令）

> **M11-6 起，正常使用不要求先 bind。** Lead 可在当前会话用 `workspace_select` 选择 Git 项目（见上文 §`workspace_select`），无需 Human Owner bind、无需项目配置、无需重启。`mcp bind` 只是**可选的持久项目级默认**——为希望冷启动即自动绑定某项目的场景提供便利。

MCP workspace binding 来源优先级：`lead_session`（`workspace_select`）> `mcp_root`（client roots/list）> `server_config`（显式 `--workspace-root`）> fail-closed。`--workspace-root` 是全局静态启动参数。

`mcp bind/status/unbind` 命令让 Human Owner 在目标项目中执行**一次**（可选）项目级激活，生成一个 `.codex/config.toml` 中的 WAO managed block（含 `--workspace-root` 绑定到项目 canonical Git root）。这提供一个持久项目级默认——但不是正常使用的前置条件。

**前置条件**：项目必须是 Codex trusted project（在 Codex Desktop 打开一次即建立 trust）。详见 Codex 官方文档 `.codex/config.toml (trusted projects only)`。

**真实可执行入口**（当前没有全局 `wao` executable）：

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

### MCP `run_status`（point-in-time 状态查询，M9-3B）

`run_status` 让 MCP host 查询一个 run 的当前状态。它直接复用与 CLI `status` 相同的 application service（`getRunStatus()`），不 shell-out CLI。只读——不写 transcript、不修改任何持久状态。

`run_status` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入只接受 `runId`——`runDir` 等控制参数是 server-owned，模型不能传。安全输出只返回机器标识 + 时间戳，不含任何内容。

`lastEvent`/`lastActivity` 在不存在时为 `null`。`lastEvent.meaning` 只对停止验证事件给出安全闭集解释：`runtime_quiet_verified|runtime_quiet_unverified|null`。因此 `type:"run.stop_verified"` 的稳定含义是“worker runtime 已静默”，它既可能来自普通终态清理，也可能来自显式 `run_stop`，不得据此推断 Lead 调过 stop。**M11-8B**：还返回 `agentId`——transcript envelope 盖戳的 canonical worker 身份（闭集字符 `[A-Za-z0-9._-]`，长度 1..128；`canonicalAgentId.js` SSOT）。只有每个事件都具备与请求 `runId` 一致的 `runId` 且同一个合法 canonical agentId 才返回该 id；缺失、冲突、非法或跨 run 一律降级为 `"unknown"`（不抛错、不伪造身份、不是自动停止门）。不从 worker 自由文本推断。**绝不返回**：原始 event payload、command/tool input/message/reason/error 内容、绝对路径、PID、prompt、argv、环境变量或 `lastActivitySummary`。这是有意的安全子集——CLI status 输出含人类可读摘要（含命令名/文件名），但 MCP 只暴露安全的机器字段。`content` 的 JSON 与 `structuredContent` 语义一致。service 失败时返回固定安全文案 `run_status failed`，不拼接异常 message/stack/path。

### MCP `run_collect`（有界结果收集，M9-4B）

`run_collect` 让 MCP host 收集一个 run 的 worker 产出。它直接复用与 CLI `collect` 相同的 application service（`collectRunMessages()`），不 shell-out CLI。**不是只读**：每次成功调用追加一个 `messages.collected` 审计事件到 transcript（不改变 terminal state）；重复调用会再次追加（非幂等）。

`run_collect` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。`cursor` 是可选的 opaque continuation token（仅 full 模式可带，值来自上一页的 `nextCursor`）；`mode` 可选（`full|compact`，省略 ≡ `full`）。`runDir`、`limit`、`serveUrl`、`sessionId`、`raw`、`includeTools` 等是 server-owned 配置，模型不能传。安全有界输出只返回 assistant 文本 + 证据计数，不含原始执行证据。

**M11-8B canonical worker identity**：`agentId` 是 transcript envelope 盖戳的 canonical worker 身份——Lead 据此确认实际 worker，**不解析 worker 自由文本**（worker 可能自报 `/root`、`Coder-HQ`、显示名或完全不报，都不改变 durable `agentId`）。缺失/冲突降级为 `"unknown"`，不抛错、不伪造身份、不是自动停止门。`agentId` 来自 collect 已读的同一份 transcript 快照，不额外读 transcript/registry/文件系统。

**R16 读绑定（TD-127/TD-128 收口，2026-08-18）**：collect 的两处会话事实读取是 **runId 绑定** 的（与 retry/resume/stop/correction 等 lane 同一 `transcript.js` 绑定读取器纪律）：`session.created` 取**末条绑定**（serveUrl/sessionId 是 serve 取回的整体重定向面，末条序与 stop/activity 同族），`run.started` 取**首条绑定**（派发时稳定事实——R12-C/R14-C 首条纪律；合法 transcript 至多一条 `run.started`，首/末取法只在伪造尾条上分叉，首条=尾条伪造永不生效）。尾部追加的外 run 伪造行（错误信封 `runId`）对 collect 不可见，也不能重定向 serve 取回的 serveUrl/sessionId/directory 参数。**行为变更（Owner 2026-08-18 拍板不兼容信封前老数据；本机实测存量 pre-envelope transcript 为 0）**：旧格式 transcript 的 serve 取回自 R16 起降级为**无会话元数据拒绝**——`session.created` 行无 `runId` 字段（pre-envelope）时，collect 以固定 `Run <runId> has no session metadata` 拒绝（零 serve fetch、零 audit append、不伪造参数），与 stop 面对同形状的处置一致；`run.started` 缺绑定行时 serve 取回**不携带** directory 参数（serve 侧默认目录——绝不采用无法归属的 cwd，也不伪造新值）。

边界：最多 8 条 message，每条 text 最多 4000 字符，全部 text 合计最多 12000 字符。**TD-119（2026-08-15，已成文契约变更而非纯 bug 修复）**：页级 `truncated:true` 仅表示"有内容被扣留待续读"（必伴 `nextCursor`）；entry 超 4000 字符设**该 entry 的** `truncated:true`（切片标记，语义见下文"单页内分块交付"）。旧的页级语义（任何超限——含 entry 切片——都设页级 `truncated:true`）已废弃：它使无损分块交付被误读为不可恢复的数据丢失（2026-08-15 Lead 三次实证）。只提取 assistant 角色 message 的 text part；assistant 文本经 secret redactor 脱敏当前进程环境中的凭据值。`messages:[]` 在无 assistant message 时是合法结果。

**M11-4 续读（continuation）**：当一次 collect 的结果超过单页边界（8 条 message、4000 字符/条、或 12000 字符总 cap），输出携带 `nextCursor: <opaque token>` 而非 `null`。Lead 用同一工具传 `{runId, cursor}` 继续读取下一页，直到 `nextCursor === null`。跨页拼接后完整、按序、无漏项、无重复；长单条 message 会在页内中途切分，下页从同一 message 的字符偏移继续；Unicode/CJK/emoji 不会在页边界拆坏 code point。**单页内分块交付（TD-119 语义修正）**：一条长消息若整条在单页预算内（≤12000 字符），会切成多条 ≤4000 字符的 entry 在**同一页一次性交付——该消息的 entry 按序拼接即全文**，`nextCursor:null`；页级 `truncated:true` 只在确有内容被扣留待续读时出现（必伴 `nextCursor`），不再把"切片交付但已完整"误报为 true；entry 级 `truncated:true` 仅表示该条目是切片。**消息边界规则**：entry 级 `truncated:false` 恰好收尾一条完整消息——多条消息落在同一页时按此切分（勿把整页 entry 盲拼成一条）；跨页续读时，同一消息的切片按序拼接。cursor 是 server-opaque 的 base64url token（≤192 字符），只含 runId 摘要 + snapshot 摘要 + 位置索引，**绝不**含 raw runId/sessionId/path/prompt/secret 或任何 worker 文本；跨 run、跨 snapshot、跨位置重放都会 fail-closed 为固定 `run_collect failed`。cursor 是纯数据，Host/MCP 进程重启后仍可续读（无进程内 session 状态）。snapshot 在首次 collect 时冻结**完整 worker-authored raw 证据序列**（所有 message/command/tool_use/tool_result/file_written 事件，不只 assistant 文本）：若 worker 在分页期间继续追加 `run.event`，续读只读取冻结前缀，`itemCount`/`evidenceCounts` 与第一页完全一致（不漂移），不重复也不跳页；篡改历史事件（非追加）会 fail-closed。投影模式（MCP 总是；CLI `--format json`/`--cursor`）读取**完整** snapshot——不会在分页前截断为 50 条（pre-truncation 会永久隐藏早期消息）；legacy raw CLI `collect <runId>` 保持 `slice(-limit)` tail 行为不变。serve 后端的 `/message` endpoint 本身支持上游分页（`before` 游标 / `X-Next-Cursor`），但 WAO 当前的 `OpenCodeServeBackend.messages` adapter 选择单次 bounded `limit` 请求，**不消费上游分页能力**。投影模式用 cap+1 sentinel（10001）探测：返回 ≥ sentinel 条说明 run 超出当前 adapter 的安全容量（10000），**立即 fail-closed** 为固定 `run_collect failed`（零 partial、零 audit append），绝不把"只拿到 serve 尾部"谎报为"完整读完"。这是 WAO 当前 adapter 的有界策略，不是声称 OpenCode 不支持分页；未来 adapter 可消费上游分页以提升容量，但 M11-4 不实现该增强。process 与 serve 共用同一分页合同（算法 shape-driven，不按 runtime 名分支）。

**绝不返回**：command string/argv、tool input/tool output/tool result raw payload、file_written path、cwd、serveUrl、sessionId、PID、unknown event raw object、prompt、环境变量、异常 message/stack。`content` JSON 与 `structuredContent` 语义一致。service/投影/redaction/output validation 全部包在同一错误边界内；任何失败只返回固定 `run_collect failed`，不泄漏 SDK output validation error、原始异常、绝对路径或 secret。**任何**投影/schema 失败——包括 invalid cursor、cursor-less 第一页 service 成功但 projection 失败、output validation 失败——都**零追加** audit event。投影模式从第一页起一律 defer append，projection + output validation 全成功后才追加一次（M11-4）。

安全边界（对应生成层 annotations）：成功调用追加审计事件；serve path 可能读取外部 runtime 服务；但不杀进程、不修改 worker checkout、不改变 run terminal。

**CLI 续读对等**：默认 `wao collect <runId>` 保持原 raw ops 输出（含完整 `data` 数组，供 ops/人读），并继续接受 `--limit N`（legacy tail 语义，`--limit 0` = 全部）。机器可读的续读入口是 `wao collect <runId> --format json`（首页）和 `wao collect <runId> --cursor <token> --format json`（续读页）；两者委托与 MCP 相同的 `projectCollectResult`，输出结构（messages/evidenceCounts/itemCount/truncated/nextCursor）与 MCP `structuredContent` 深度语义一致。投影模式是 strict parser：`--cursor`/`--format` 缺值或空值在读取 transcript 前即拒绝（不静默退回 raw collect）；`--limit` 在投影模式被拒绝（pagination 由投影层固定，用户 limit 会与之冲突）；未知 flag、重复 flag、多余 positional 均拒绝。投影模式从第一页起 defer audit append，projection + output validation 全成功后才追加一次。

**M12-2A compact 模式**：可选输入 `mode` ∈ `{full, compact}`（省略 ≡ `full`）。`compact` 在**一次调用**内返回最后一条 assistant 文本（经与 full 完全相同的 redaction + C0/C1/DEL sanitization 后的原样文本，≤4000 字符）以及来自**同一份完整安全快照**的 `evidenceCounts`/`itemCount`——让 Lead 在终态后通常只需一次 collect 即可看到 worker 的最后结论与完整证据计数，而非 6-9 页 full 收集。compact **复用** full 的 `extractAssistantTexts`/脱敏/sanitization/`evidenceCounts` SSOT（不复制解析算法、**不做语义摘要**、**不决定**是否需要 full 输出）。compact **不接受 cursor**（cursor 仅 full 可带）；`compact+cursor` 在 service/read/append 之前 fail-closed 为固定 `run_collect failed`，非法 `mode` 同样 fail-closed。compact 输出在 full 全部安全 base 字段之外，**仅 compact** 额外返回三个字段：`view`（恒 `"compact"`）、`compactStatus`、`assistantMessageCount`（形状与出现条件见生成层）。

`compactStatus` 为闭集三态：`available`（≥1 条 assistant 文本，且最后一条 ≤4000 字符 → `messages` 恰好一条完整原样文本，`truncated:false`）；`empty`（无 assistant 文本 → `messages:[]`）；`too_large`（最后一条 >4000 字符 → `messages:[]`，**不**给部分文本、**不**给 cursor——需要全文时用 full 模式（默认）分页读取：长消息按 ≤4000 字符 entry 无损分块交付，语义见上文 TD-119；MCP 消费者直接省略 `mode` 即为 full）。三态均为 `truncated:false`、`nextCursor:null`；`assistantMessageCount` = 完整快照中 assistant 文本条数（注意它与 `evidenceCounts.message`——所有 message-shape 条目含 user——不同）。每个 compact **成功**严格追加**一个** `messages.collected`；任何 input/投影/schema/service 失败（含 `compact+cursor`、非法 `mode`、serve sentinel ≥10001）追加**零**个（投影模式 defer append，projection + output validation 全成功后才提交）。compact 不是摘要、不是 final-answer 决策，也不替代 full 续读。

**CLI compact 对等**：`wao collect <runId> --mode compact` 进入与 MCP 相同的 compact 投影（`--mode compact --format json` 等价；`--mode` 单独即触发投影模式）。`--mode full` 与现有 `--format json` 机器投影兼容。strict parser：`--mode` 缺值、非法值（非 `full`/`compact`）、`--mode compact --cursor`、未知 flag、重复 flag 均在读取 transcript 前拒绝；默认 raw `wao collect <runId>` 保持不变。

**CLI `--final`（最终答复一屏出口，TD-112）**：`npm run cli -- collect <runId> --final` 复用与 MCP compact 完全相同的投影/脱敏/消毒路径（同一 `projectCollectResult`，无第二解析器），把**最后一条 assistant 文本**按四态渲染到 stdout，适合脚本/流水线直接取最终答复：

- `available`（最后一条 assistant 文本 ≤4000 字符）→ stdout 恰为**消毒后**的最终 assistant 文本（secret redaction + C0/C1/DEL 清洗之后，不承诺逐字节等于原文），exit 0；
- `empty`（无 assistant 文本）→ 固定标记 `[final: no assistant message]`，exit 0；
- `too_large`（最后一条 >4000 字符）→ 固定指引 `final message exceeds bounded projection; re-run without --final: collect <runId> --format json (slices of one message concatenate - an entry with truncated:false ends a message; follow nextCursor across pages)`（不给部分文本、不给 cursor；`<runId>` 是占位描述，不插值真实 runId——指引明确要求去掉 `--final` 重跑才能拿到 JSON 全量，并注明 full 模式的分块拼接与消息边界语义（TD-119），不再让长消息消费者误以为指引是死路），exit 0。

`--final` 是布尔 flag（不接受值），与 `--cursor` 互斥（沿用 compact 的既有互斥拒绝，非零退出）；`--final` 与 `--format json`/`--mode` 同用时由 `--final` 的四态渲染接管输出。成功调用与 collect 一致追加恰好一条 `messages.collected` 审计事件（`--final` 不豁免——collect 本就非只读）；任何输入/投影失败零追加。

### MCP `run_diagnose`（安全确定性诊断，M9-5B）

`run_diagnose` 让 MCP host 诊断一个 run 的失败原因分类。它直接复用与 CLI `runs diagnose` 相同的 application service（`getRunDiagnosis()` → `diagnoseFailure()` 内核），不 shell-out CLI。只读——不追加 transcript event、不修改 terminal state、不给处方或建议。

`run_diagnose` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入只接受 `runId`；runDir/raw/includeEvidence/recommend/retry/worker/strategy 等是 server-owned，模型不能传。安全输出只返回机器字段，不含 raw evidence fact。

`category` 来自 `DIAGNOSIS_CATEGORIES` SSOT（闭集 enum，含 `provider_capacity` 与 delivery worktree 越界的 `workdir_escape`）。`signalEventTypes` 只保留 evidence 的 event type（最多 8 条，每条 ≤64 字符，异常映射为 `unknown`），**绝不返回** raw fact/error/detail/reason/check name/command/tool payload/path/timestamp/prompt/PID/sessionId/provider stderr/环境变量，也**绝不返回** recommendation/advice/retry/nextStep。`content` JSON 与 `structuredContent` 语义一致。失败返回固定 `run_diagnose failed`。

**诊断码（`code`）**：可空闭集字段，取值属于单一通用 SSOT `DIAGNOSIS_CODES`（`src/diagnosis.js`，由 provider-auth、provider-capacity 与 no-effect 三组代码派生），并必须通过 `isValidDiagnosisCode(category, code)` 的**类别—码配对**校验：`provider_auth` 使用 `subscription_access_disabled` / `organization_policy_denied` / `api_key_missing` / `unauthorized` / `invalid_credential`；`provider_capacity` 使用 `rate_limited` / `quota_exhausted`；`no_effect` 使用 `completed_empty`（见下方 M12-21）；其余类别恒为 `null`。`provider_capacity` 只从 **failed 终态**的持久 `run.error` 分类，非终态 runtime `rate_limit_event` 不会被升级为失败。所有 code 都是安全事实标签，**永远不**回显原始错误文本/path/command/key/payload；非法/越集 code 或错配的（类别, 码）折叠为 `null`。WAO 不根据这些事实自动重试、换 worker 或停止其他 run，处置归 Lead。CLI `runs diagnose` 显示同一 category 与 code。

**M12-21 completed-empty 真相（`category=no_effect`，线路 `code=completed_empty`）**：进程 exit 0 / parser `done(completed)` 只是**传输完成**，不是 worker 产出可用结果的证据。一个 completed run 若仅有 transport 活动（runtime init/streaming、thinking、zero-usage metrics）而无任何可用产出（非空 assistant 文本、命令活动、文件写入、tool_use/tool_result），归类为 `no_effect` + 事实码 `completed_empty`（`src/diagnosis.js` 的 `NO_EFFECT_DIAGNOSIS_CODES`）。Lead 校正后**线路与内核统一**：MCP `run_diagnose` 与 `run_await_result` 都把 `category=no_effect` 与 `code=completed_empty` **同时**透出到 wire——`completed_empty` 是 Lead 可机读的"空转完成"事实，不再折叠为 `null`。线路 `code` 闭集由单一通用 SSOT `DIAGNOSIS_CODES` 约束，经 `isValidDiagnosisCode(category, code)` 配对校验：`no_effect`、`provider_auth`、`provider_capacity` 仅能携带各自代码，其余（含 **failed** 的 `no_effect` run）恒为 `null`；正常 completed 仍 `category=none` / `code=null`。`completed_empty` 只命名这条机器真相，**永不**回显 provider 原文/argv/path/prompt/secret。有效的 tool-only / command-only / file-written 完成仍判 `none`。配套：claude-code parser 在成功 result 事件含非空 `result.result`、且此前未流式输出过相同 assistant 文本时，会补发恰好一条 assistant 消息再 done，避免 resume 场景的最终答案丢失（已流式输出相同文本则不重复）。

### MCP `run_delivery`（只读 delivery 查询，M9-6B + M11-1A + M11-10）

`run_delivery` 让 MCP host 查询一个 run 的 delivery 状态。只读，不追加 transcript event。MCP 自身不解析 transcript、不 shell-out CLI——只委托同一份 application service。

`run_delivery` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。`runId` 必填；`waitMs` 为**可选**整数（区间与 `waitMs=0` 无效的约束见生成层描述；省略 → point-in-time 输出，M9-6B + M11-1A + M11-8C 向后兼容；提供 → 触发 bounded read-only readiness wait（M11-10））。**Host 传输丢失/取消不会停止 detached run**——调用只是结束，run 继续运行；Lead 应重新 point-in-time 读取观察（`run_delivery`/`run_wait`/`run_await_result`/`run_delivery_review_bundle` 均如此，绝不可据传输中断推断 run 已停止）。安全输出不返回完整 DeliveryRef / raw diff / file content / reason / commands / results / worktreePath / branch / integration。

字段语义（形状与闭集枚举见生成层）：

- Commit hash 校验为 40/64 位十六进制。
- `changedFileCount` = DeliveryRef 中全部 changed files 的真实总数（不受 cap 影响）。
- `changedPaths` = 最多 **64** 条、确定性顺序（与 DeliveryRef 的 sorted canonical 顺序一致）、repo-relative、forward-slash 的安全路径。这是 review metadata，**不是 raw diff 或文件内容**。64 cap 是 server-owned 常量，模型不能通过 tool argument 控制。
- `changedPathsTruncated` = `changedFileCount > changedPaths.length`（即真实总数超过 64 cap）。
- 只有 `verificationStatus === "passed"` 表示 exact-artifact verification 已通过，Lead 仍负责语义判断。
- `verificationFailureSummary`（M11-12B，nullable）仅当 `verificationStatus === "failed"` 时非 null，是**安全事实摘要**——让 Lead 定位哪个声明检查失败，但绝不泄漏命令文本/stdout·stderr 内容/signal/path/env/credential/prompt/动态错误。严格 8 键对象，且仅含安全标量：`code`（与 `verificationFailureCode` 同一闭集投影；`failed` 时缺失/非法/未知一律为 `unknown`）、`failedCommandIndex`、`declaredCommandCount`、`executedCommandCount`、`exitCode`、`timedOut`、`stdoutBytes`、`stderrBytes`。`exitCode` 保留 Windows 非负 32 位值（含 9009；不按 POSIX 0..255 截断），负/小数/非数/`> 0xffffffff` 一律 null。per-command 字段（`exitCode`/`timedOut`/`stdoutBytes`/`stderrBytes`）仅当 `results[failedCommandIndex]` 是 `result.index === failedCommandIndex` 的 plain object 时投影；不匹配/缺失/malformed 时保留 counts/index/code 但置空这四个字段。malformed 数据 fail-safe 且向后兼容（非 failed 状态为 null）。无产品 vs 环境分类、无处方/重试/stop/accept-reject、无新工具/日志子系统。**R17（TD-130 W1）边界澄清**：持久层（transcript 事件内 DeliveryRef 的 `results`/`setupResults`）自 R17 起对失败命令携带加性 `stdoutTail`/`stderrTail` 有界诊断尾（≤8192 字节/侧 + 截断标记，随整包 exact-secret 脱敏；见 §三事件表 `run.delivery_verification_failed` 行），但**本 MCP 摘要边界不随之放宽**——`verificationFailureSummary` 仍是 8 键纯标量，尾内容不越过 wire；需要尾内容的 Lead 直接读 transcript JSONL。

路径投影的安全边界：每个 path 经 `src/delivery.js` 的 repo-relative 校验 SSOT 复验（拒绝绝对 Windows/POSIX/UNC、`..`/`.` traversal、空 segment、尾分隔符），并额外限制长度 1..512、无控制字符、无 NUL、统一 forward-slash。任何 malformed path 一律 fail-closed —— 整个 projection 不返回部分结果，调用折叠为固定 `run_delivery failed`，不泄漏恶意值。失败返回固定 `run_delivery failed`（不拼接异常、路径或 secret）。

**M12-13 isolation_failed（隔离违反 readiness）**：终端（已到终态）且已请求 delivery 的 run，若其**唯一**较高优先级 delivery 事实是恰好一条 run-bound 的安全 `run.isolation_violation`（顶层 durable `code` 为闭集 `workdir_escape` 字符串），readiness 立即 settle 为 `isolation_failed` 并投影 `isolationFailure:{code:"workdir_escape"}`——这是与 packaging failure（`deliveryFailure`）**严格分离**的第三类失败形状。规则：任何既有 delivery 事实（delivery_created / verification outcome / packaging failure / Lead decision）**优先于**隔离事实；isolation_violation 缺失、多于一条、跨 run、code 非安全闭集或顶层 `code` malformed → fail-closed 折叠为 `ambiguous`。`isolation_failed` 意味着**无 packaging、无 diff、无 review、无 decision 面**——不出现 `candidateInventory`、不触发 repackage/salvage/retry/stop/decision 任何动作，Lead 只能另行派发。`run_await_result` 的 `outcome.delivery.isolationFailureCode` 投影同一事实（无隔离失败时 `null`）。

**结构化无交付 / packaging failure**：`deliveryRequested` 明确区分本次 run 是否声明过 delivery。普通非 delivery run 返回 `deliveryAvailable:false, deliveryRequested:false, deliveryFailure:null`，这是正常查询结果而非错误；已请求但尚未打包则返回 `deliveryAvailable:false, deliveryRequested:true, deliveryFailure:null`。当存在绑定当前 runId 的 durable `run.delivery_failed`（如 `base_commit_mismatch`），返回 `deliveryAvailable:false, deliveryRequested:true` + `deliveryFailure.code`（闭集安全 code，未知/损坏/注入 code 投影为 `unknown`，不回显原值）。transcript 缺失/损坏或 durable 事实冲突仍固定返回 `run_delivery failed`。`run_delivery_decide` 在没有 DeliveryRef 时仍不可调用成功。`run_diagnose` 对 packaging failure 返回 `category:"delivery_packaging_failed"`（只给事实不给处方/重试）。

**Candidate inventory（M12-1S1/M12-4A/M12-19 附加只读投影）**：可恢复候选附加 nullable `candidateInventory` 与 `candidateKind:"disallowed_scope"|"backend_failed"|"process_missing"`——持久化的**原始批准路径**、candidate 的**实际**改动路径（相对持久化原始 base 的 tracked diff + 非 ignored untracked，两次必需 Git read 都成功才产出），以及其中超出原始合同的子集。`disallowed_scope` 来自绑定的 `disallowed_path` packaging failure；`backend_failed` 只来自已请求 delivery、唯一终态 `failed` 原因为 `backend_error|backend_stream_ended`、存在绑定 `run.stop_verified` 且无 stop/isolation/budget/scorecard/既有 delivery chain 冲突的 retained worktree；`process_missing` 是**唯一非终态**恢复候选——已请求 delivery、仍处 `pending|submitted|running` 的 run，其 detached runner/provider 进程被**保守地证明已消失**（owner lease 缺失或 stale-valid 且 owner PID 已证死，且唯一 `session.created` 的 `backendSessionId` 形如 `proc_<pid>` 的子进程 PID 仅在 ESRCH 时判死；EPERM/未知/探测错误一律判活、绝不误判死），恰好一个绑定 `run.started`（canonical base + 非空 allowedPaths + 持久 worktreePath + verification 声明），且无任何 delivery_created/outcome/decision/repackaged/delivery_failed/`run.process_missing_confirmed`/冲突事实。形状：`{ originalAllowedPaths, originalAllowedCount, originalAllowedTruncated, actualChangedPaths, actualChangedCount, actualChangedTruncated, disallowedPaths, disallowedCount, disallowedTruncated }`；每条路径列表 cap 256（wire schema `maxItems:256`/`maxLength:512` 可见），count 永远是去重排序后的完整基数，truncated 精确反映截断。它是**纯 advisory 事实**：null 表示 Lead 人工核实，绝不自动 scope 扩展/repackage/stop/retry/decision/推荐；`process_missing` 尤其**绝不等于语义 accept**——只有 Lead 显式调用 `run_delivery_repackage` 才能以 first-terminal-wins 原子结算该 orphan。失败关闭规则：workspace ownership、恰好一个绑定 `run.started`（含可用 delivery 上下文）、linked-worktree-at-base 证明（worktree HEAD 恰好等于持久化原始 baseCommit）任一失败、owner lease corrupt/malformed 或 fresh、owner/子进程 PID 仍活/未知、任一必需 Git read 失败、任一路径未过严格投影 SSOT（`validateProjectedPath`），或候选 inventory 为空/任一列表截断 → 整个候选投影为 null（绝不部分真实）；无 authority => null 且零 worktree/Git read。其它 failure code、success 和非候选状态不携带候选字段；point-in-time 与 waitMs readiness 两条路径投影一致。严格只读：transcript 字节、HEAD/branch、index/worktree 内容不变；MCP 输出绝不返回 PID/path/错误文本。

**M11-10 delivery readiness handshake（可选 bounded 只读 wait）**：提供 `waitMs` 时，`run_delivery` 在同一份共享 application service（`getRunDeliveryReadiness`，CLI/MCP 共用）内做 bounded read-only readiness wait，并额外返回 `readiness`/`waitReturnedEarly`（形状与闭集枚举见生成层）。

- `readiness` 为严格闭集（消费方必须视其为穷举，任何其它值都是 bug；`isolation_failed` 为 M12-13 新增，见上）。
- `reviewable` 仅当存在 durable `delivery_created` **且**恰好一个绑定该 runId 的最终 verification outcome（passed/failed/unavailable），并复用共享 `validateDeliveryFacts` SSOT 作为最终权威；failed/unavailable 仍为 reviewable（不自动 reject，Lead 仍负责 accept）。
- 冲突或不完整的 durable 事实（多个 created/verification/packaging failure、commit 不匹配、跨 run ref、created+failed、有 verification outcome 但无 bound created，或 run 已终态但声明的 delivery 没有 created/failed 结果）折叠为 `ambiguous`（fail-closed，不回显动态值）；后者会立即返回，不耗尽 wait 窗口。
- wait 是 workspace/runId-bound、非忙等（两次 re-read 之间 sleep）、**零 transcript append**、bounded polling（deadline = 起始时间 + waitMs）。MCP 长 wait 复用 `run_wait` 的 SDK-native progress/timeout 模式（`notifications/progress` keepalive + `resetTimeoutOnProgress`）；`waitMs` 区间由共享常量 `DELIVERY_WAIT_MS_MIN=1000`/`DELIVERY_WAIT_MS_MAX=300000` 锁定，zod schema 与 service 业务边界都从同一常量构造，不可漂移。
- pending-at-deadline 是**诚实的事实**（`waitReturnedEarly:false`），不是错误；wait 绝不 stop/retry/accept/reject。初始读取失败即抛错（不进入 wait）；wait 期间某次 re-read 失败时，不把 stale waiting 快照伪装成 deadline 到期，而是 fail-closed 为 `ambiguous` 并提前返回（`waitReturnedEarly:true`，不回显错误、不重试）。
- 安全投影复用既有 `run_delivery` 投影（commit/path 校验、redaction、闭集、fail-closed 不变）；`run_delivery_review` 的 exact-proof / 安全投影 / 错误边界**未被放松**。

CLI 等价：`runs delivery <runId> --wait-ms N [--format json]`（`--wait-ms` 缺值或非整数/越界在 service 调用前拒绝；省略 `--wait-ms` 时保持旧 point-in-time 形状，无 `readiness` 字段）。

### MCP `run_activity`（Lead 有界活动时间线，M12-8A）

`run_activity` 是 workspace-bound、只读、幂等的活动下钻工具。它从**同一份 transcript 快照**投影一页事实，不追加 audit，不直接返回 JSONL，也不做进度估计、总结、建议或下一步裁决。

- 输入：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。`categories` 闭集（含 M12-16 的 `correction`）与 `afterSeq`/`cursor` 形状以生成层为准；`pageSize` 为 1..50；`cursor` 是由上一页返回的 opaque token。
- 输出：当前 state/terminal、各类别总计、当前页 entries、`truncated`/`nextCursor` 和 `availableDrilldowns`。message 只给脱敏后的有界文本；command 只给 `ok|failed|unknown`，不返回 argv；tool 只给名称/错误布尔；文件只给安全 repo-relative path；`runtime_status` 只给 `initialized|streaming|provider_retry|unknown`，不返回 stream delta/retry error/session/model；未知事件只用固定 sentinel。
- 安全顺序：完整动态文本先 exact-secret redaction，再清洗 C0/C1/DEL，再截断/分页。绝不返回 raw command、tool input/output、error text、credential、PID、provider session 或绝对路径。
- cursor 绑定 runId、冻结快照前缀、audience/filter/afterSeq 视图和位置；append-only 增长可继续。历史变更/收缩、跨 run/view/audience、malformed 或越界 cursor（M12-19）**不再仅返回通用错误**，而是返回一个**有界结构化恢复结果**：闭集事实 `status:"cursor_rejected"` + 静态 `choices`（`isError:true` 且携带 `structuredContent`）。WAO 只呈现事实与选择——**绝不自动重试、自动重启分页、停止、改写或替 Lead 决策**，也不回显 raw cursor、不匹配子类型、run/workspace 路径或动态错误文本；恢复结果只含 `status`+`choices`，**不含任何首页 entries/counts/nextCursor**（Lead 须显式重新请求）。恢复选择：**重新请求无 cursor 的第一页**（全新 cursor 链），或用已知 wait/activity 序列中的 `afterSeq`（如来自 `run_wait`/`run_await_result` 的数值 cursor）重入。跨 workspace 访问、无效 transcript envelope、畸形 snapshot/output、输出校验失败及未预期内部错误仍保持固定通用错误（`run_activity failed`，**无 structuredContent**）。Lead 可任意时点重复读第一页，或沿 `nextCursor` 逐页下钻。
- `scopeObservation`（M12-14，advisory、additive）：闭集 `within_declared_paths | outside_declared_paths | unknown`，`source` 恒为 `"transcript_file_events"`，附 `observedFileCount`、`outsidePaths`（脱敏后的安全 repo-relative 路径，上限 25 条）/`outsidePathCount`/`outsidePathsTruncated`。`complete:true` 的准确语义：观察到的 transcript 快照已是**终态**，且该快照中每一条确认的 `file_written` 路径都能在**恰好一个有效合同权威**（绑定 runId 的 `run.started` 绝对 worktreePath + 非空合法 `delivery.allowedPaths`）下求值；它**不**证明文件系统完整性、语义正确性、交付验证或 Lead 验收，也**不**表示 worker 仍在运行（`complete` 的前提是快照终态）。快照未终态或任一确认路径无法求值 → `unknown`（`complete:false`）。
- `readOnlyObservation`（R4，advisory、additive、**仅声明过只读的 run 才出现**）：闭集 `no_writes_observed | writes_observed | unknown`，`source` 恒为 `"transcript_file_events"`，附 `observedFileCount`、`writtenPaths`（脱敏后的安全 repo-relative 路径，上限 25 条）/`writtenPathCount`/`writtenPathsTruncated`。权威 = 恰好一条绑定的 `run.started`（绝对 worktreePath）+ 恰好一条绑定的 `run.read_only_declared`；任一 file_written 路径无法在 worktree 下求值、权威缺失/歧义、声明缺失/重复/跨 run → 整体 `unknown`（fail-closed）。**诚实口径**：status 报**当前快照观察**——非终态快照也可 `writes_observed`（运行中告警，呈现≠动作）；`no_writes_observed` 是"未观察到写"（基于工具上报证据），**不是**"没写"；`complete:true` 仅当快照终态且全部可求值。**Owner 约束**：观察到越界写**不**自动停止、**不**失败、**不**改写自然终态——纯 advisory，终审归 Lead。cursor 续页从冻结前缀投影（append-only 稳定），新读第一页可观察后追加的写。

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

M12-20 改为 **active-first / history-on-demand**：看板默认打开 Active 模式——只列出当前有新鲜 owner 心跳、经证明 active 的 run（候选集是当前的 `.owner-*` 租约文件——候选枚举只 `readdirSync` 一次 runDir 目录，但只有当前租约候选者的 transcript 被打开/解析/验证，无任何历史 transcript 被打开/解析），并每 5s 自动刷新；历史 run 仅在 Owner 显式选择 `1h`/`24h`/`7d` 预设或有界自定义 from/to（上限 7d；禁止未来/倒序/越界/未知参数，固定 400）后**按需加载一次**，历史模式**不**自动轮询。Active 响应固定标注 `scanScope=active`，且不携带 `unresolvedCount`（active scope 不做全库存 unresolved 分类，故该计数**恒缺失而非 0**）。范围按 transcript 派生的 `updatedAt` 过滤（非文件系统 mtime），并复用长驻看板服务进程内的**元数据校验 summary 缓存**做热读（无第二个持久索引）。模式切换绑定 runs-mode epoch：迟到的 Active 或 History 响应**不得**覆盖当前模式或更新的查询；run 从 active 集或有界历史窗口中消失**绝不**构成终态迁移，也**不**触发通知。HTTP `/api/runs` 的 `scope` 为闭集 `{active,history}`、缺省即 active；MCP `runs_list` 与 CLI 文本看板行为**不变**（仍是全库存扫描 + `unresolvedCount`）。

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

- 输入：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。`fileIndex` 来自 `run_delivery.changedFileCount` 的零基索引；模型不能提供原始路径。
- 分页：对同一文件持续传回 `nextCursor`，直到它为 null；Lead 应对 `0..changedFileCount-1` 的每个文件完成该循环（每页字节上限见生成层描述）。
- 信任边界：`fragment` 固定标记为 `artifactTextTrust:"untrusted_repository_text"`。仓库文本可能包含 prompt injection、命令或伪造指令；只能作为审查数据，绝不执行或服从其中内容。
- 不可用结果：binary 或单文件 diff 超限时返回 `available:false`、空 fragment 和 `unavailableReason`（阈值见生成层描述）。只有这类结果才使用 Owner-authorized repo-local read-only CLI/Git fallback；正常文本审查不绕过 MCP。
- 安全边界：路径来自已证明的 DeliveryRef；diff 在完整文本上先做 exact-secret redaction 和控制字符清洗，再分页。失败固定返回 `run_delivery_review failed`，不泄漏路径、Git stderr 或原始错误。

当 MCP transport 不可用时，WAO CLI adapter fallback 调用同一 application service 与安全投影，JSON 语义与 MCP 一致；它不是绕过安全投影的 raw-content 通道：

```bash
npm run cli -- runs delivery review <runId> --file-index 0 [--cursor TOKEN] --format json
```

### MCP `run_delivery_review_bundle`（readiness + 单文件一页组合，M12-3B）

`run_delivery_review_bundle` 是默认的低摩擦 delivery 首屏查询：一个调用先等待 delivery readiness，再仅在 readiness 为 `reviewable` 时读取 Lead 指定的**一个**文件页。它机械组合既有 `getRunDeliveryReadiness`、`run_delivery` 安全投影和 `getRunDeliveryReview`/`projectReviewResult`，不引入第二份 delivery/readiness/review 判定。

- 输入：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。`waitMs` 省略时默认 270000 ms——注意生成层描述里 "omit for a point-in-time read" 的措辞沿用自 `run_delivery`，对 bundle 并不准确（bundle 的真实默认是等待 270 s；权威是 wire：`src/mcp/server.js` 的 `DELIVERY_REVIEW_BUNDLE_DEFAULT_WAIT_MS`）。合法区间与 `run_delivery` readiness 共用；readiness 稳定即提前返回。它是**一次** readiness 等待预算，不会给 delivery 和 review 分别再分配一个 wait。
- 输出（strict）：`delivery` 为 `run_delivery` 安全投影，`review` 为单页 review 或 `null`。非 `reviewable` 状态返回 `review:null`，同时保留完整安全 delivery/readiness 事实；该路径零 diff/Git review read。`reviewable` 时 review commit 与 changed-file count 必须和 delivery 投影精确一致，否则整次调用固定失败。
- **Lead 权限不变**：WAO 不选择 `fileIndex`、不遍历文件、不追 `nextCursor`、不总结 fragment、不判定 binary/diff-too-large 是否可接受，也不 stop/retry/repackage/accept/reject。Lead 仍须审查 `0..changedFileCount-1` 的全部文件和全部页面，然后独立调用 `run_delivery_decide`。
- **原子路径保留**：`run_delivery` 继续提供 point-in-time/readiness-only 查询；`run_delivery_review` 继续提供单独或 continuation-page 读取。长 worker、人工轮询、故障排查和非标准流程不受组合工具限制。
- **安全边界**：workspace/runId-bound；非 reviewable 时携带 cursor 会 fail-closed，而不是静默忽略；任何服务异常、malformed output 或跨 artifact 拼接固定返回 `run_delivery_review_bundle failed`，无 partial structured output、动态错误、路径或 secret 泄漏。

### MCP `run_delivery_reverify`（audited 未变工件重验证，M12-6）

`run_delivery_reverify` 是 Lead 声明的一次性**审计式重验证**：仅当原始终态 verification **failed** 且 Lead 已判断为闭集环境/工具原因（`tooling_invalid` / `environment_contaminated` / `dependency_setup_missing`）时，对**同一个未变 delivery commit** 重跑验证。它委托共享 application service `runDeliveryReverify.js`（与 CLI fallback 同一份），**不调用 model、不 resume worker、不解析 transcript**。原始 assertion 命令**逐字节重跑且不可修改**；Lead 只能追加新的 setup 命令。任何 reverify 都**不自动 accept/reject**——decision 仍只由 Lead 经 `run_delivery_decide` 作出。

- **输入**（strict）：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。`reason` 是闭集环境/工具原因（枚举见生成层）；`setupCommands` 可选（每条非空、上限 32 条、每条 ≤512 字符，常量与 service 同源）；`timeoutMs` 可选（整数，与 M12-13 `verificationTimeoutMs` 共享闭界 `[1000,7200000]`，zod 边界与 service 常量同源）——省略时**继承**该 delivery ref 上持久化的执行预算，ref 无持久值才用 service 默认 300000；持久值缺失/损坏/越界 fail-closed 拒绝（不自动回退默认值）。模型不能传 runDir/cwd/命令覆盖/force 等控制参数。
- **eligible failure**：原 verification 的失败 code 必须是环境/工具闭集（`command_failed`/`command_timeout`/`execution_error`/`setup_failed`/`setup_timeout`/`setup_environment_error`）；内容完整性失败（`artifact_mutated`/`artifact_mismatch`）**不可** reverify。已有 Lead decision 或 reverify 链损坏一律 fail-closed。
- **幂等/并发**：reentrant + crash-safe——重试/并发收敛到**首个调用者**记录的 setup 与同一个 commit，最多一条 durable outcome（`run.delivery_reverification_requested` → `run.delivery_reverification_outcome`）。原始终态 verification **不被改写**。
- **原 vs effective verification**：`run_delivery` 投影同时保留 `originalVerificationStatus`（durable 原始 outcome）与 `effectiveVerificationStatus`（reverify 结果，含 `reverify: {status, reason}` 链事实）；只有完整 reverify 链（requested + outcome）存在时 effective 才可取，非完整链（none/pending/malformed）**不允许**改变 effective 状态（fail-closed）。
- **安全输出**（不返回 commands/worktree 路径/stderr/reason/env/raw events；字段形状与闭集见生成层）。

Lead 仍须在 decision 前完整 review（`run_delivery_review` / `run_delivery_review_bundle`）并独立决定；reverify passed 不构成 acceptance，reverify failed 也不自动 reject。失败返回固定 `run_delivery_reverify failed`，无 partial structured output、路径或 secret 泄漏。

当 MCP transport 不可用时，WAO CLI adapter fallback 调用同一 application service 与安全输出投影，JSON 语义与 MCP 一致；它不是绕过安全投影的 raw 通道，也不提供 assertion-command override：

```bash
npm run cli -- runs delivery reverify <runId> --reason tooling_invalid [--setup-commands-file FILE] [--timeout-ms N] [--run-dir DIR] [--cwd DIR] [--format json]
```

`--setup-commands-file` 是 UTF-8 JSON string array（缺失 = 空数组；拒绝非数组/非字符串/空白/超界，边界常量与 service 同源）；`--timeout-ms` 缺失由 service 解析（继承 ref 持久预算，否则默认 300000），提供时必须为共享闭界 `[1000,7200000]`（与 M12-13 `verificationTimeoutMs` 同源）内严格整数；`authorizedWorkspaceRoot` 由 CLI 既有 cwd/workspace proof 路径产生，调用方输入不能绕过 workspace ownership。

### MCP `run_delivery_decide`（持久 Lead 决策，M9-6B）

`run_delivery_decide` 让 MCP host 记录一个 Lead 决策（accept/reject）。**不可逆**（首决策 wins，后续 lose）。调用共享 service 委托 `tryAppendDecision` 的锁内原子 first-decision-wins 语义。

- **输入**（strict）：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。`reason` 上限 2000 字符；runDir/force/merge/push/raw/includeReason 等控制面参数被拒绝。
- **安全输出**（不返回 reason/DeliveryRef；字段形状与闭集见生成层）。

**expected policy rejection 是正常结构化结果，不是错误**：已存在决策（first-decision-wins 的 loser）或其它 durable 策略拒绝（verification/终态/reject-gate/durable facts 冲突）返回 `decisionAccepted:false` + 闭集 `rejectionReason`（如 `already_decided`）——这是结构化 outcome，消费方按正常结果处理，不视为 tool failure。只有 unexpected/internal 异常（非策略拒绝）才返回固定 `run_delivery_decide failed`，无 partial structured output。Reason 在持久化前 trim+redact，但**绝不返回**给 MCP。

### MCP `run_delivery_repackage`（model-free 重打包，M12-1S2/M12-19）

`run_delivery_repackage` 由 Lead 对 `run_delivery` 已投影的 `candidateKind:"disallowed_scope"|"backend_failed"|"process_missing"` 候选传入 `{ runId, allowedPaths }` 重打包。它**复用**该 run 原始持久化的 worktree / base / verification 配置：不调用 model、不 resume worker、不推断 path、不修改 verification 命令、不自动 accept/reject。`candidateInventory.originalAllowedPaths` 给出新合同必须保留的旧批准范围；Lead 审查实际与越界路径后，独立提交最终 `allowedPaths`，它是**唯一**新 scope 权威，并且必须包含全部原始路径且覆盖**所有**实际变更路径。重打包重新计算完整候选清单；read-fail/truncate/empty 一律拒绝。WAO 不合并清单、不判断修改是否合理。原始 `verificationCommands`/`unavailableReason` 按 `run.started` 原值复用，不接受 caller 覆盖。

**process_missing 结算（M12-19）**：与前两类（终态 failed）不同，`process_missing` 候选是**非终态** orphan。repackage 在任何持久化变更**之前**先证明全部前置条件（workspace ownership、运行时 liveness、原始合同、完整非空未截断 inventory、Lead scope 覆盖），然后以 first-terminal-wins 原子写入一条安全确认事实（`run.process_missing_confirmed`，无 PID/path 载荷）与一条到 `failed` 的状态转移（闭集 reason `process_missing`），再重读权威事实。若并发终态已先到，仅当权威终态独立符合既有恢复 kind（`disallowed_scope`/`backend_failed`/`process_missing`）时才继续，否则**拒绝且不动 Git**。非终态 run 上已存在的 `run.process_missing_confirmed` 事实（不完整/损坏的持久化记录）在**任何变更之前**使候选失效并拒绝。结算后再与其余恢复 kind 走完全相同的打包/精确验证/provenance/幂等语义。无 model/backend/session resume。

- **输入**（strict）：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。
- **可重入/崩溃恢复/并发安全**：相同输入的并发或重试 → 恰好一条终态事实、恰好一条 `run.delivery_created` 与恰好一个最终 verification 结果；不同 allowedPaths 的竞争请求不会互相覆盖（含 process_missing 竞争请求收敛到同一终态/commit/验证）。打包在 transcript append 锁外进行（长操作不持锁）；只有短读/校验/CAS-append 在锁内。包装移动了分支但 transcript append 失败/崩溃时，下次同名调用从 Git 精确对象恢复**同一个** commit（严格证明 parent/count/files/message/identity/branch/clean 后才落盘，不丢结果、不重调 model）。
- **安全输出**（不返回 worktreePath/commands/stderr/reason/PID/path；字段形状与闭集见生成层）。

追加一条 recovery provenance（`run.delivery_repackaged`），绑定 DeliveryRef / 请求 runId / 已批准 scope / `recoveryKind`。原始终态 failed **不被改写**为 completed；但当且仅当 durable recovery facts、provenance、唯一 DeliveryRef 与 verification chain 一致且 verification=passed 时，`run_delivery_decide(accepted)` 可被 Lead 显式接受（仍由 Lead 决定，非自动）。verification failed/unavailable 仍可供 Lead review/reject，绝不自动 reject。

失败返回固定 `run_delivery_repackage failed`。`run_delivery`（结果查询）与 `run_delivery_review` 仍是结果查询/审查 SSOT。

### MCP `run_stop`（stop runaway worker，M10 P0-2）

`run_stop` 让 MCP host 停止一个失控的 worker run。它直接复用与 CLI `stop` 相同的 application service（`runStop.js`），不 shell-out CLI。**destructive，workspace-bound**——只允许停止 host-authorized workspace 绑定范围内的 run。

`run_stop` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入只接受 `runId`——`runDir`、`force`、registry、timeout 等控制参数是 server-owned 配置。安全输出只返回机器标识 + 终态事实，不含路径/PID/session。

`terminalAccepted`（first-terminal-wins 仲裁是否认领 `aborted`）、`terminalState`（终态）、`sideEffectAttempted`（是否执行了 taskkill/abort 等破坏性副作用——rejected loser 为 false）、`stopVerified`（进程式 worker 已退出，或 OpenCode session 已由 status + token/message 稳定性确认静默）。OpenCode 观察面不可读时返回 unverified，不能把网络/endpoint 失败当作已停止；观察到 session 仍 active 时也只报告并告警，WAO 不自动执行会杀死其他 session 的全局 `taskkill /IM opencode.exe`。**绝不返回**：PID、进程路径、session id、argv、command、绝对路径、prompt、环境变量或异常 message/stack。失败返回固定安全文案 `run_stop failed`。

**安全契约**：workspace-bound——run 必须属于当前 host-authorized workspace，否则拒绝。不返回 PID/path/session 等可被用于跨 workspace 探测的标识。stop verification 以后置 PID 存活检查为准，不假验证（ESRCH=已退出，EPERM/未知=保守 alive）。

**行为变更（R13-C / TD-127，补录）**：stop 杀进程 lane 的会话查找（`session.created`）与 agentId 读取（`run.started`）自 R13-C 起为 **runId 绑定读取**（末条绑定——尾部追加的外 run 伪造 `session.created` 不再能夺走 kill 目标进程）。由此，**信封时代之前的 legacy transcript（事件无 `runId` 字段）的 stop 从"去杀"变"拒绝"**——绑定读取无匹配，落入既有 `no session metadata`（无 `session.created`）拒绝面。本机 pre-envelope transcript 存量为 0（TD-129b 实测），实际影响 ≈0。

CLI fallback：`npm run cli -- stop <runId>`。

### MCP `runs_list`（project-bound run 列表，M10 P0-3）

`runs_list` 让 MCP host 列出当前 host-authorized workspace 绑定范围内的 run（project-bound recovery）。只读、幂等——不修改任何持久状态、不追加 transcript event。

`runs_list` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。输入两字段均可选。`activeOnly`（bool，默认 `false`）：只返回**经证明 active** 的 run——即 transcript 为已知非终态**且**有 fresh owner heartbeat（`ownerLiveness` SSOT，默认 10s 阈值）。注意（M12-15）：单纯"未到终态"**不足以**算 active；一个非终态但缺少 fresh heartbeat 的 run 不在 `activeOnly` 结果里，但也**绝不**据此推断它 failed/dead/stopped（仍可能长时间运行/休眠），它计入 `unresolvedCount` 并仍出现在普通（非 `activeOnly`）列表中。`limit`（整数 1..100，默认 `50`）：返回条目数上限。模型**不能**传 `runDir`、registry、`agentId`、`cwd`、`workspaceRoot` 等 server-owned 配置——workspace 绑定由 server 解析，不能通过 tool argument 提供。

安全有界输出只返回机器字段 + 终态/活动事实，不含路径/session/prompt。`runs` 每个元素含 `runId`/`agentId`/`state`/`terminal`/`updatedAt` 以及 M12-15 的闭环活动投影字段：

- `activityStatus` ∈ `terminal` | `active` | `unresolved` | `unknown`
- `activityBasis` ∈ `terminal_state` | `fresh_owner_heartbeat` | `no_fresh_owner_heartbeat` | `unknown_state`

`active` 要求已知非终态 + fresh owner heartbeat；`unresolved` = 非终态但无 fresh heartbeat（**绝不**等同于 failed/dead/stopped）；终态与无法识别的 state 永不为 `active`。`returnedCount` = `runs.length`；`truncated` 表示因 `limit` 截断而仍有更多匹配 run；`unresolvedCount` = 全量扫描中已知非终态但缺 fresh heartbeat 的 run 数（受 `limit` 之前、与 `activeOnly` 无关），供 `lead_preflight` 复用而无需重新扫描。**绝不返回**：PID、进程路径、session id、argv、command、绝对路径、prompt、环境变量、messages、evidence 或异常 message/stack。失败返回固定安全文案 `runs_list failed`。

一次 `runs_list` / `lead_preflight` 查询会先证明授权 workspace，再按查询范围缓存每个不同 ownership cwd 的 Git 顶层证明（包括 fail-closed 的不可证明结果）；不会为同一项目的每个历史 run 重复启动 Git 证明进程。缓存只活在单次查询内，不跨调用持久化，也不改变 workspace 隔离、过滤或错误投影。

**Workspace-bound**：只返回当前 host-authorized workspace 绑定范围内的 run——其它项目的 run 不可见（project-bound recovery，不跨 workspace 探测）。workspace 未绑定时返回空 `runs:[]`（不 fail-closed，因这是只读列举而非 state-changing）。

CLI fallback：`npm run cli -- runs list [--agent ID] [--latest N]`。

### MCP `run_wait`（long-poll 终态/活性等待，M10-pre3）

`run_wait` 让 MCP host 以 long-poll 方式等待一个 run 到达终态或产出 liveness 摘要，避免 busy `run_status` 轮询。它直接复用与 CLI 同等的 application service（`runWait.js`，读 transcript + owner 心跳 freshness SSOT `ownerLiveness.js`），不 shell-out CLI。**只读**——不追加 transcript event、不修改 terminal state、不改变 run 生命周期。

`run_wait` tool：参数与形状见 docs/surface/mcp-tools.md（生成层，随代码再生成）。`runId` 必填；`runDir`、registry、`force`、timeout 等控制面参数是 server-owned 配置。`afterSeq`（整数 ≥0，可选）：

- **省略**：service 把首次读取 transcript 时的最大 `seq` 作为基线——只统计等待窗口内出现的新进展，不把历史事件误报为 progress（这是首轮 poll 的默认行为）。
- **显式 `0` 或正整数**：调用者有意统计 `seq > afterSeq` 的全部进展（含历史），用于续读。把上次返回的 `cursor` 当 `afterSeq` 传回即可增量续读。

`waitMs` 是 Lead 的单次观察窗口（区间、默认值与 `waitMs:0` 有意无效的约束见生成层描述）；point-in-time 读取使用 `run_await_result({waitMs:0})` 或 `run_status`。窗口到期只返回 liveness，**不表示 worker 失败，也不会中止 worker**。

- **返回时机**：服务在两种情况下返回——(1) run 到达终态（completed/failed/aborted/timed_out），此时 `returnedEarly:true`；(2) `waitMs` 到期仍未终态，此时 `returnedEarly:false` 并附带 liveness 摘要让 Lead 决定下一步。**普通新事件不会触发提前返回**——只有终态会；窗口内的新进展通过到期的 liveness=`progress` 体现。
- 若返回 `terminal:true`，该终态事实已足够，Lead 直接进入 `run_collect`；除恢复、独立复核或没有 wait 结果外，不需要再调用一次 `run_status`。

安全有界输出只返回机器字段 + liveness 摘要，不含内容/路径/session。字段语义（形状与闭集枚举见生成层）：

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

> 故障排查的深度内容见 `docs/troubleshooting.md`（按症状快速索引 + provider/CLI 与 shell/工作目录/runs 故障域，本文不搬运）；本节只保留高频一句话问答。

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
