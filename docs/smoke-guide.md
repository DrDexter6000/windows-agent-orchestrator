# Smoke 指南

> 真实 CLI 的最小派发验证。`npm test` 用 mock 子进程；本页的操作调用真实模型，消耗真实 token。

## npm run smoke 做什么

`npm run smoke`（`src/smoke.js`）自动跑一轮真实 smoke：

- 探测 PATH 里的 `claude` 与 `codex`，探测到的进入本次 smoke。最后没有任何可跑的 backend（包括点名的 backend 没探测到）就以失败退出。
- 在临时目录生成一次性 registry（cwd=当前目录），prompt 固定为 `Reply with exactly: smoke ok`。
- 每个 backend 跑一次 run，等完成后读 transcript，验证状态链含 running 与 completed、终态为 completed，并打印 assistant 回复。
- 只跑其中一个：`npm run smoke -- codex`（或 `claude`）。
- opencode-serve 默认不跑。传 `opencode` 或 `glm` 才探测：对 `127.0.0.1:4297-4299` 逐个 GET `/api/session`，探测到就加入本次 smoke，否则警告并跳过。serve 要先自己起：`opencode serve --hostname 127.0.0.1 --port 4297`。模板已不含 opencode 车道，这条只回归通道本身。
- 传 `scorecard` 只跑 scorecard 专项（见下），不跑普通 smoke。
- `--isolate` 让 run 在隔离 git worktree 里执行，报告会打印 worktree 路径。
- transcript 写在 `os.tmpdir()` 下的 `wao-smoke-*` 临时目录（按项目分桶），结束时打印路径并保留。

脚本只覆盖 claude-code、codex、opencode-serve（显式）。其余后端（zcode、kimi-web、deepseek-acp 等）的里程碑证据，按 `docs/milestone-discipline.md` §4 第 4 条取自该车道的 reliability；手动 smoke 只用于排查。

### scorecard 专项

`npm run smoke -- scorecard` 需要 claude CLI，未找到时判失败退出。两个场景：

- 证据满足：让 claude 创建一个文件，配 requireFiles。期望 run completed、scorecard passed=true。
- 证据不满足：配一个不存在的 requireCommands 命令。期望 run failed、scorecard passed=false，末次状态迁移原因为 `scorecard_failed`。

registry 自动加 `--dangerously-skip-permissions`，否则 claude 的 Write 工具不真正执行。

## 手动对一条车道做 smoke

车道名和各自的 backend 见 `config/agents.example.json`（`npm run cli -- wao lanes` 一屏列出）。各车道的前提（kimi 的 worker serve、deepseek 的目录权限、zcode 的环境桥）见 `docs/usage/lanes.md`。

先复制本地 registry：

```powershell
Copy-Item config/agents.example.json config/agents.json
```

命令一律 `npm run cli --`，显式带 `--cwd` 与 `--registry`：

```powershell
# 单次 run（等完成，打印 assistant 文本）
npm run cli -- run glm-flash --prompt "Say hello in one sentence." --cwd <目标项目> --registry config/agents.json

# spawn 后台 + 看状态
npm run cli -- spawn deepseek-flash --prompt "List files in cwd." --cwd <目标项目> --registry config/agents.json
npm run cli -- runs list
npm run cli -- status <runId>

# JSON 输出看完整结果
npm run cli -- run sol --prompt "What is 2+2?" --cwd <目标项目> --registry config/agents.json --format json
```

参数与输出形状以 `docs/surface/cli.md` 为准。上面的示例只给车道名，不注入角色合同；要带角色就写成 `run --lane <车道> --role <角色>`，规则见 `docs/usage/dispatch.md` 的角色合同一段。

验证点：

- `run` 返回并打印了 assistant 文本。
- transcript 含 `run.state_change` 链：pending→submitted→running→completed。transcript 按项目分桶，落在 `runs/projects/<slug>/<runId>.jsonl`（旧平铺 `runs/<runId>.jsonl` 只读兼容），定位链见 `src/projectBuckets.js`。
- `--format json` 的 messages 含 assistant 角色。
- codex 车道：输出混入非 JSON 行（如 ERROR 日志）不影响完成——解析器逐行 try-parse，失败的行跳过（`src/backends/parsers/lineStream.js`）。

## 故障排查

- claude 报 `stream-json requires --verbose`：backend 已内置 `--verbose`（`src/backends/claudeCode.js`）。仍出现说明没走 WAO 的 backend，检查 registry 条目的 backend 字段。
- codex 报 git repo check：backend 已内置 `--skip-git-repo-check`（`src/backends/codex.js`）。
- 进程 abort 后残留：主动 abort 时 WAO 用 `taskkill /pid <pid> /T /F` 杀进程树；仍有残留就手动再执行一次。

## 认证

runtime/model 组合的认证（`npm run reliability`）见 `docs/certification-runbook.md`，不在本页展开。
