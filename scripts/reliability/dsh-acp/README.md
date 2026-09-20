# DSH ACP 后端 — B-2 验证资产（可复现）

**来源**：2026-09-19 B-2 技术验证（ADR-0031 §1/§2）。零依赖（纯 `node:` 内置模块），**不含任何凭据**。

## 文件

| 文件 | 作用 |
|---|---|
| `acp-probe.mjs` | ACP 客户端探针：`new` / `list` / `resume` 三模式；驱动 `dsh --profile acp` 并记录 wire 事实 |
| `acp-smoke.mjs` | containment 冒烟：`initialize → session/new → session/close`，**不调用模型**，用于二分定位可安全关闭的插件 |
| `acp-tool-sample.mjs` | 工具名采样：抓 `tool_call` 的真实字段形状与工具名 |
| `wao-contain-safe.patch.yml` | 实测收敛的 containment 覆盖层（`--patch` 叠加到 shipped `acp` profile）|
| `evidence/*.json` | 各阶段原始输出（F2–F5 的证据） |

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
```

## 边界（诚实声明）

- 这些探针证明的是**组合能否建立与 wire 事实**，**不是** WAO 集成验收，也不是认证证据。
- containment 覆盖层经 `--dump-config` 与 `session/new` 实测，**不是** OS 级沙箱隔离。
- 上层 `dsh` CLI 与后端能力由操作员准备；WAO 只 detect / invoke / report。
