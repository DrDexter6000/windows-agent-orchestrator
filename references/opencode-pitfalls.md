# opencode-serve Pitfalls（可选 lane，按需读）

> opencode 已全线降级为可选 lane（06-18 事故后，主力切进程式 claude-code/kimi-code）。
> 本文件只在你要用 opencode worker 时读。主力路径（claude-code/kimi-code 进程式）不涉及这些坑。
> 来自 SKILL.md 原文（2026-06-24 移出，progressive disclosure）。

## 1. providerID 必须匹配 opencode 注册的 provider 名

Wrong: `"providerID": "deepseek-coding-plan"` → 401。Correct: `"providerID": "deepseek"`, model `"deepseek/deepseek-v4-flash"`。For Zhipu: `"zhipuai-coding-plan"` + `"glm-5.2"`。providerID 是 opencode 注册时的名字，别猜，查 opencode config。

## 2. serveUrl 端口必须匹配实际 `opencode serve --port`

默认 4297。若用 `--port 4298` 起 serve，registry 的 serveUrl 要一致。不匹配表现为 hang（connection refused / timeout），不是清晰报错。

## 3. oh-my-openagent (OmO) 插件会污染 session

若装了 OmO 插件，它可能往 session 注入 `# Maestro System Context` 块（编排指令）。这违反原则 #1（不灌编排进 agent context）。WAO 不注入——WAO 只发干净 task text。看到 Maestro System Context 是 OmO 插件，不是 WAO。修复：WAO 场景禁用该插件，或隔离 opencode config。

## 4. 无限多轮模型——用 `completionMode: "first-stable"` + 配 tokenBudget

DeepSeek-v4-flash 回答后无限生成确认轮（不设 time.completed）。默认 snapshot-stable 模式下 WAO 轮询到 waitTimeout，期间 serve 端无限烧 token。配 `completionMode: "first-stable"`：首条含非空 text 的 assistant message 即完成 + abort。

**Abort now verified (Safety Gate 2026-06-23)**：stop 后轮询 3 轮，未停则 taskkill + 告警（TD-37）。`_runCleanup` 路径未验证（TD-38），靠 tokenBudget 兜底。

**必配 tokenBudget**：opencode agent 加 `"tokenBudget": <number>` + `"tokenBudgetMultiplier": <number>`（默认 100）。超限即 failed + abort + 告警。唯一不依赖 abort 生效的防线。

## 5. opencode serve 进程必须继承 provider key

opencode.json 用 `{env:ZHIPU_API_KEY}` 引用 key。若 serve 进程启动时没继承这些 env（自动启动/被别的工具拉起），读不到 key → 每个 provider 调用 401 → WAO 看到卡 submitted 超时。这是"WAO 401 但 opencode TUI 正常"的头号原因——TUI 继承了终端 env，serve 没有。

**用 `scripts/serve.ps1` 起 serve**——它从 User registry 读 key 注入 serve 进程。
