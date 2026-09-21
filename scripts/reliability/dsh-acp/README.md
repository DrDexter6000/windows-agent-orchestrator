# DSH ACP 后端 — B-2 验证资产（可复现）

**来源**：2026-09-19 B-2 技术验证（ADR-0031 §1/§2）。零依赖（纯 `node:` 内置模块），**不含任何凭据**。

## 文件

| 文件 | 作用 |
|---|---|
| `acp-probe.mjs` | ACP 客户端探针：`new` / `list` / `resume` 三模式；驱动 `dsh --profile acp` 并记录 wire 事实 |
| `acp-smoke.mjs` | containment 冒烟：`initialize → session/new → session/close`，**不调用模型**，用于二分定位可安全关闭的插件 |
| `acp-config-option.mjs` | config-option 可设置性探针：单会话内 `set_config_option` 对 `reasoning_effort`/`model` 的 set-确认 + 负对照，**不发 prompt**（Phase 5，2026-09-20） |
| `acp-tool-sample.mjs` | 工具名采样：抓 `tool_call` 的真实字段形状与工具名 |
| `wao-reuse-drill.mjs` | §3.6 会话复用关联面真实 WAO 派发 drill（Phase 6，2026-09-21）：正向跨 run 恢复 + 三条负向 fail-closed；经 `dispatchRun` fork 真实 detached runner→RunManager→backend→dsh→模型 |
| `wao-contain-safe.patch.yml` | 实测收敛的 containment 覆盖层（`--patch` 叠加到 shipped `acp` profile）|
| `evidence/*.json` | 各阶段原始输出（F2–F6 的证据） |

## 复现

```powershell
# 1) 造一个一次性工作区
$ws = Join-Path $env:TEMP ("dsh-acp-probe-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $ws | Out-Null

# 2) 需要 DEEPSEEK_API_KEY。DSH 会读 User 环境变量；本进程没有时必须显式注入：
$env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
$env:PROBE_WS = $ws

# 3) 单轮 + 工具调用（F3）
node scripts/reliability/dsh-acp/acp-probe.mjs new

# 4) 跨进程恢复（F4）：记下上一步的 sessionId，再用**另一个进程**恢复
node scripts/reliability/dsh-acp/acp-probe.mjs list
node scripts/reliability/dsh-acp/acp-probe.mjs resume <sessionId>

# 5) containment：叠加覆盖层后再跑（`session/new` 成功 = 组合可建立）
$env:PROBE_PATCH = (Resolve-Path scripts/reliability/dsh-acp/wao-contain-safe.patch.yml)
node scripts/reliability/dsh-acp/acp-smoke.mjs

# 6) config-option 可设置性（Phase 5）：单会话、**不发 prompt**（零模型 token）。
#    缺省叠加本目录 containment 覆盖层；PROBE_EFFORT 可指定首个 set 目标值
#    （须在广告值域内）。evidence 落盘用 PROBE_OUT：
$env:PROBE_WS = "<一次性工作区>"
$env:PROBE_OUT = "scripts/reliability/dsh-acp/evidence/phase5-config-option-set.json"
node scripts/reliability/dsh-acp/acp-config-option.mjs           # 首个目标 = 第一个 != 当前值的广告值
$env:PROBE_EFFORT = "low"
$env:PROBE_OUT = "scripts/reliability/dsh-acp/evidence/phase5-config-option-set-low.json"
node scripts/reliability/dsh-acp/acp-config-option.mjs           # 首个目标钉 low
Remove-Item Env:PROBE_EFFORT, Env:PROBE_OUT
```

## Phase 5 结论（evidence/phase5-config-option-set*.json，2026-09-20，dsh 0.1.5-rc.2）

- `session/set_config_option { sessionId, configId, value }` **存在且可设置**：
  `reasoning_effort` set `high→off`、`→low`、`→max` 的响应 configOptions
  `currentValue` 均确认生效值；`model` set 同样被接受（currentValue 变更——
  **仅取证，WAO 未接线 model**）。
- **负对照**：`reasoning_effort = "medium"`（WAO registry 闭集成员，ACP 不广告）
  被拒：`-32602 "Invalid params: unknown reasoning effort for
  deepseek-official/deepseek-v4-flash: medium"`。
- 每次运行一个会话、**零 prompt**（evidence 里 `promptSent: false`），不消耗模型 token。
- 未证明的（诚实边界）：**没有**证明模型真的按所设档位推理（那需要发 prompt 且
  无客观判据）；**没有**证明 `high` 单独 set 生效（它是 session/new 的缺省
  currentValue，与 off/low/max 走同一 wire 通道）；`model` 的 set 只有单值取证，
  不构成 WAO 侧接线依据。

## Phase 6 结论（evidence/phase6-session-reuse.json，2026-09-21，dsh 0.1.5-rc.2，Node v22.23.1）

ADR-0031 §3.6 关联面落地的**真实 WAO 派发**证据（非裸探针）：

- **正向**：同 lane（`coder_low_dsh_reuse`）同身份两次派发——run1 `first_turn_requested`
  （写入随机 marker，ACP session `811d622a-…`）→ run2 `resume_requested`
  （`run.session_reuse.turn=resume`，`session.created.backendSessionId` 与 run1 **相同**，
  assistant 复述 marker）——跨进程、跨 WAO run 的真实上下文恢复。
- **负向×3**（全部拒绝，绝不静默新会话）：前任转录 `backendSessionId` 改空 → 派发拒绝
  （固定文案）；routing 条目损坏 → 派发拒绝；关联指向不存在会话 → 上游
  `-32602 "session is not resumable"` → run failed（不回退 `session/new`）。

复现（消耗真实 token，保持最小；run1/run2 是两小轮，负向 C 在模型前失败）：

```powershell
node scripts/wao-node.cjs scripts/reliability/dsh-acp/wao-reuse-drill.mjs
# 前置：dsh 在 PATH；~/.wao/runtimes/dsh-acp/wao-contain.patch.yml 已装；
# DEEPSEEK_API_KEY 在 Windows 用户环境。registry 默认只读外层主仓 config/agents.json，
# 复制到 <repo>/.wao/runs/drill-agents.json（--registry-source 可换来源）。
```

诚实边界：drill 经 `dispatchRun`（CLI `run --background` 与 MCP `run_dispatch` 共享的
派发服务）+ **固定 leadSession** 模拟 MCP server 的稳定注入——CLI 每次派发一次性
leadSession（设计如此），同身份复现只能这样进；MCP 注入面由
`test/run-lifecycle/m11-11c-sessionReuse.test.js` MCP-1/MCP-2 单测钉住。run 产物在
`<repo>/.wao/runs/phase6-reuse-runs/`。**删除** routing 条目（而非损坏）会回到"条目
不存在 ⇒ first"的 M11-11C provider-中立合同（ADR-0031 §3.6 裁定范围注）——该路径
未在本 drill 执行（会多烧一轮模型 token），属已知设计行为而非未测缺陷。

## 边界（诚实声明）

- 这些探针证明的是**组合能否建立与 wire 事实**，**不是** WAO 集成验收，也不是认证证据。
- containment 覆盖层经 `--dump-config` 与 `session/new` 实测，**不是** OS 级沙箱隔离。
- 上层 `dsh` CLI 与后端能力由操作员准备；WAO 只 detect / invoke / report。
