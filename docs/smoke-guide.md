# Smoke 测试指南

> 真实 CLI 手动 smoke 测试。自动化测试用 mock 子进程，不依赖真实 API。
> 这里是验证真实 claude/codex 能跑通的操作步骤。

## 前置

确认 CLI 在 PATH：
```powershell
where claude   # 应输出 C:\Users\<you>\.local\bin\claude.exe
where codex    # 应输出 npm 全局路径
```

复制本地 registry（按你的实际路径改 cwd）：
```powershell
Copy-Item config/agents.example.json config/agents.json
# 编辑 config/agents.json，把 cwd 改成你的项目目录
```

## Claude Code smoke

```powershell
# 单次 run（等完成，打印 assistant 文本）
npm run cli -- run coder_low --prompt "Say hello in one sentence." --registry config/agents.json

# spawn 后台 + 看状态
npm run cli -- spawn coder_low --prompt "List files in cwd." --registry config/agents.json
npm run cli -- runs list --registry config/agents.json
npm run cli -- status <runId> --registry config/agents.json

# JSON 输出看完整结果
npm run cli -- run coder_low --prompt "What is 2+2?" --format json --registry config/agents.json
```

验证点：
- [ ] `run` 命令返回且打印了 assistant 文本
- [ ] transcript（`runs/<runId>.jsonl`）含 `run.state_change` 链：pending→submitted→running→completed
- [ ] `--format json` 的 messages 含 assistant 角色

## Codex smoke

```powershell
npm run cli -- run tester --prompt "Say hello in one sentence." --registry config/agents.json
```

验证点：
- [ ] 即使 codex 输出混入非 JSON ERROR 行，run 仍正常完成
- [ ] transcript 状态链正确

## OpenCode serve smoke（回归）

```powershell
# 先起 serve
opencode serve --hostname 127.0.0.1 --port 4297
# 另一个终端
npm run cli -- run researcher --prompt "Summarize this project." --registry config/agents.json
```

验证点：
- [ ] opencode-serve 路径未因 M2 重构破坏

## 混合 registry smoke

```powershell
# registry 里同时有 opencode + claude + codex
npm run cli -- registry list --registry config/agents.json
# 应列出三个 agent，各自 backend 不同
```

## 故障排查

- **claude 报 `stream-json requires --verbose`**：确认 ClaudeCodeBackend 的 buildArgs 含 `--verbose`（已内置）
- **codex 报 git repo check**：确认 buildArgs 含 `--skip-git-repo-check`（已内置）
- **进程 abort 后僵尸**：Windows 上 taskkill /T /F 杀进程树，若仍有残留手动 `taskkill /pid <pid> /F`
