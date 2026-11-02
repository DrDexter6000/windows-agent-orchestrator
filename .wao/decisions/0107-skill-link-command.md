# 0107 技能链接命令 skill link/unlink：核实槽位里的 wao-orchestrator junction

- 日期：2026-11-02
- 状态：accepted
- 来源：Owner 2026-11-02 批准的窄口子（"只有显式的技能链接命令，可以在核实过的技能目录里创建或删除名为 `wao-orchestrator`、指向唯一 WAO 检出的目录链接（junction）"）。
- 关系：承接 0043（宿主表三能力轴与"宿主配置文件零写入"边界）、0049（链接同体零漂移，不维护拷贝同步）、0091（dsh 边界）。不改变 MCP 工具面；`hostVerified` 仍只表示 MCP 加载。

## 背景

1. 0049 把"技能发现路径与全局入口应以目录链接指向唯一物理检出"定为部署模型，但建/删链接一直是手工操作（`mklink /J`、手工 rmdir），`Remove-Item -Recurse` 误用还会穿透删掉目标检出（AGENT_ONBOARDING 曾专门警示）。
2. 2026-11-02 Lead 实测（各候选目录放临时探针技能，再无头问宿主看到哪些）：claude-code（桌面内置）读 `~/.claude/skills`（新技能几秒内出现在正在运行的会话），不读 `~/.agents/skills`；codex 0.165.0 读 `~/.agents/skills` 与 `~/.codex/skills`；kimi-code 2.4.0 读 `~/.agents/skills` 与 `~/.kimi-code/skills`，不读 `~/.kimi/skills`；zcode CLI 0.17.1 未核实（无头 `-p` 两次报 SQLite 迁移初始化失败）；opencode、claude-desktop、dsh 未测。
3. 槽位事实此前没有家：AGENT_ONBOARDING §4b 逐个列路径，其中"zcode 从 `~/.agents/skills` 发现"是未核实的观察——违反 0043"仅纳入格式已核实的宿主"的表纪律。

## 决定

1. **宿主表新增可选 `skillSlot` 纯事实字段**（dir 相对用户主目录 + 核实证据：日期、宿主版本、方法；可选 `homeProof`=证明宿主已装的主目录）。它不是第四根能力轴；没有核实证据的宿主不给。共享的 `.agents/skills` 只定义一次，codex 与 kimi-code 引用它——一条链接两宿主受益。
2. **新命令族 `skill link --host <id> [--apply]` / `skill unlink --host <id>|--all [--apply]`**，默认只预览、零写入。实现单一落点 `src/application/skillLink.js`；doctor 与 unlink --all 共用同一份状态盘点。
3. **链接目标 = 正在运行的检出根**（从模块位置推出）。它是链接工作树（`git rev-parse --git-dir` ≠ `--git-common-dir`）或不是 git 顶层时拒绝——不猜、不提供覆盖参数（worktree 会被收走，链接会变断链）。
4. **状态闭集**：`absent` / `linked-current`（junction 且规范化目标等于检出根，Windows 大小写不敏感）/ `linked-other` / `not-a-link`（普通目录或文件，含物理拷贝）/ `broken-link` / `unknown`。link 只在 absent 态创建；unlink 只删 linked-current，用非递归 `rmdirSync`，删完确认链接没了、目标检出文件还在——绝不用 `rmSync({ recursive })`。无 `--force`。宿主主目录不存在时拒绝（宿主没装）；`skills` 子目录不在时可以建。
5. **doctor 逐槽位报告**（替换写死的 `~/.agents/skills` 单槽位探测）：按槽位路径去重，列出读它的宿主、状态、目标；恒 INFO（5c/5d 纪律：机器态不影响 verdict）；写明"链接在 ≠ 宿主已加载"；缺槽位是 INFO。三根盘点照常工作。
6. **卸载接入**：`install.ps1 -Uninstall` 删仓前跑 `skill unlink --all --apply`，失败即中止、不删仓（否则留断链；已摘掉的链接不恢复）。任一槽位状态读不了（unknown）时 unlink 在删任何链接之前就拒绝；检出缺 `package.json`、跑不了 unlink 时卸载同样中止。

## 否决的备选

- **并进 `mcp bind`**：绑定 MCP 注册与技能安装是两件事、生效面不同（配置文件 vs junction），合在一起会让 snippet-only 宿主 bind 的"零写入"承诺变得含混；单独命令的语义可独立审计。
- **借用 `hostVerified` 表达"技能槽位已核实"**：`hostVerified` 有精确含义（真机验证 MCP 加载），混入技能槽位核实会稀释决定 0043 声称的边界——所以是独立事实字段。
- **所有宿主一键全装（`skill link --all`）**：没有核实槽位的宿主只能给手工指引，一键会对未核实宿主假装成功；link 侧保持逐宿主（unlink 的 `--all` 是给卸载的，且只删指向本检出、状态为 linked-current 的链接，风险面不同）。
- **物理拷贝 SKILL.md 进槽位**：拷贝是漂移源，0049 已裁定不维护拷贝同步；junction 同体零漂移。

## 已知边界

- zcode、opencode、claude-desktop、dsh 无 `skillSlot`：命令只打印"按该宿主的文档安装"，零写入；实测证据补齐后才入表（照 0043 表纪律）。
- "链接在 ≠ 宿主已加载"：本命令不声称加载，doctor 报告写明；宿主是否真读以 `skillSlot` 证据为准。
- codex/kimi-code 还各自读宿主私有目录（`~/.codex/skills`、`~/.kimi-code/skills`），WAO 不在那里建第二份链接——共享槽位一条链接已覆盖两宿主。
- 链接工作树拒绝的判定跑 `git rev-parse`（一次子进程）；探测失败按 not-git 拒绝，不猜。
