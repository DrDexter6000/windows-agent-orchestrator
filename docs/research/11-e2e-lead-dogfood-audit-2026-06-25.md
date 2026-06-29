# 11 — e2e Lead-Agent Dogfood 审计（2026-06-25）

> 类别：**过程（Process Log）**，时间冻结快照。本文记录一次"以 lead agent 身份实机走完整 e2e"的 dogfood 审计发现的 friction，以及处置决策。不复述架构/状态机（见 `02-architecture.md`）。

## 背景

把视角放在"安装并使用 WAO 的 lead agent"上，实机走完整条职责链：装技能 → 读 SKILL.md → registry validate/list → 挑 worker → 派发 → 轮询 → 验收 → 清理。目标是发现文档/工具链里 lead 实际会踩的坑，而非测代码逻辑（那是 npm test 的事）。

## 发现的 friction（按严重度）

### F0 — 技能 frontmatter 缺身份声明（已修）

- **现象**：宿主 agent 读 `description` 决定是否加载技能，但 description 只说"能干什么"，没说"加载者应是 lead 身份"。身份判断被推迟到正文第 6 行（加载后才看到）。worker/副主控可能误加载。
- **根因**：技能加载靠 description 匹配触发，frontmatter 是唯一的"加载决策点"，但它没有身份约束。
- **处置**：description 开头加 `[LEAD-ONLY]` 前置声明（commit 99009e4）。

### F1 — 纯 spawn（无 --wait）对进程式 backend 状态机永不推进（文档对齐，能力归 M7）

- **现象**：纯 spawn coder_low，worker 实际完成、文件写好，但 status 轮询 60s 永远卡 `submitted`，transcript 只到 seq=6。
- **根因**：状态迁移（submitted→running→completed）发生在 `waitForCompletion()` 内部，它消费子进程 stdout→事件流→状态机。纯 spawn 不调它，对进程式 backend 没人读 stdout（进程式的"会话"就是那个子进程，不像 opencode 有服务端 session 可事后查）。
- **矛盾**：SKILL.md 把"后台 spawn + status 轮询"当主推用法之一，但只对 opencode-serve（已降级 fallback）成立，对当前主力 lane 半瘫痪。
- **处置**：
  - B1（已做，commit 781c2e9）：文档对齐——进程式 worker 必须 `--wait`（或 run/workflow），纯 spawn+轮询仅限 opencode-serve。
  - B2（归 M7）：fork detach 后台消费进程守 stdout 推进状态。这是 M7 daemon 的最小前身，不在当前范围做。

### F2 — stop 命令对进程型 run 无效（已修）

- **现象**：卡住的纯 spawn run 用 stop 清理，报 `no OpenCode session metadata`。stop 只认 opencode session。
- **根因**：stop 实现去 opencode 服务器调 abort session，进程型 run（backendSessionId=proc_<pid>）没有这种 session。
- **与 F1 叠加**：失控进程型 worker 既无法被 status 检测完成（F1），又无法被 stop 叫停（F2）——只剩手动 taskkill。
- **处置**：C1（commit 99009e4）——stopCommand 检测 `proc_` 前缀时走 taskkill /T /F 路径（进程死即会话死，taskkill 成功即 verified），与 opencode abort+verify 路径分流。1 红绿测试覆盖。

### F3 — spawn 输出格式不一致（已文档化）

- **现象**：spawn --wait 输出两段 JSON（确认+结果），纯 spawn 一段。脚本 `JSON.parse` 直接收整段会失败。
- **处置**：commit 781c2e9 文档说明"解析 runId 取首段"。

### F4 — scorecard 验收默认不生效（认知摩擦，未改）

- **现象**：派发不带 `--scorecard-rules`、registry 不配 → `runs scorecard` 显示 `(none)`。SKILL.md 把 scorecard 列为"程序级第一道筛"，但 opt-in 不主动配就形同虚设。
- **处置**：暂不改（设计如此 opt-in）。后续考虑 workflow 模板默认带最小 scorecard。

### F5 — registry list 信息薄（已修）

- **现象**：原仅 id/backend/cwd，缺模型。选型靠 SKILL.md 手维护的角色表（易 stale）。
- **处置**：commit 781c2e9，list 加 model 列。

### F6 — SKILL.md 用旧 agent 名（已修）

- **现象**：多处用 `coder_deepseek_claude`（registry 不存在），配置示例 researcher=opencode（实际=claude-code）。lead 照抄示例会 agent not in registry。
- **处置**：commit 781c2e9，全部替换为实际角色名，配置示例对齐真实 registry。

## 走得顺的部分（不需改）

- 技能加载、registry validate、`--wait` 模式派发+验收完整可用：evidence 链、metrics、文件交付物准确。
- sentinel 验证有效（worker 真读文件，非背诵/伪完成）。
- transcript 是真 source of truth（tail 完整还原事件流）。
- 进程式 lane 在 --wait 模式下安全性名副其实。

## 进程清理确认（e2e 副产物）

派发的两个 worker（PID 62044 /wait、52868 纯spawn）均已自行退出，无残余 headless 烧 token。环境里的 claude.exe/node.exe 经命令行核实均非 WAO 派发。

## 处置汇总

| Friction | 处置 | commit |
|----------|------|--------|
| F0 frontmatter 身份 | 修（LEAD-ONLY） | 99009e4 |
| F1 纯 spawn 状态卡死 | B1 文档对齐（已做）+ B2 归 M7 | 781c2e9 / roadmap |
| F2 stop 进程型 | 修（C1 taskkill 路径） | 99009e4 |
| F3 spawn 输出格式 | 文档化 | 781c2e9 |
| F4 scorecard 默认关 | 暂不改（设计如此） | — |
| F5 registry list | 修（加 model 列） | 781c2e9 |
| F6 旧 agent 名 | 修（替换） | 781c2e9 |

测试 421→422（+1 进程型 stop）。

## 第二轮 e2e 新发现 friction（N1-N5）—— 已全部修复（2026-06-25 第二批）

第二轮"以 lead 身份从头 e2e"暴露产出获取/run 定位/验收的问题族：

| Friction | 处置 | commit |
|----------|------|--------|
| N1 registry list 缺认证状态（lead 要跑两命令 join） | 修（list 合并 reliability-summary cert 列） | 981a666 |
| N3/N5 runs list 列历史所有 run，找"刚才那次"费劲 | 修（加 --agent/--latest N 过滤） | 86e0445 |
| N4 transcript 不存 assistant text（动摇 source-of-truth；影响所有 backend） | 修（message 事件落 run.event） | 98c58a8 |
| N4b collect 对进程型 run 报 "no OpenCode session" | 修（进程型从 transcript 重建 messages） | 161711f |
| F4 scorecard 默认 opt-in，不配形同虚设 | 修（workflow 模板默认带 requireEvidence） | ffe3688 |

测试 422→429（+1 N4 +1 N4b +2 过滤 +2 N1 +1 F4）。

## 核心判断

WAO 当前主力 lane 全是进程式 backend（决策 0005），但后台管理能力（无 wait 跟踪、stop 叫停、产出获取、run 定位）原为"常驻服务器型"设计。**架构迁了，管理能力两轮补齐：叫停（C1）+ 文档对齐（B1）+ 产出落 transcript（N4）+ collect 重建（N4b）+ run 过滤（N3/N5）+ 认证视图（N1）+ 验收默认（F4）。唯一剩余能力补全是后台消费进程（B2），归 M7 daemon。**
