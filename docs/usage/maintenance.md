# 维护

> [使用手册](../usage.md)的一页：清理历史 run 与工作树，跑 daemon，开 Owner 看板。

## 管理历史 run

```powershell
npm run cli -- runs list                    # 列出所有 run + 状态
npm run cli -- runs list --project <路径|裸名> # 按项目过滤（路径=键精确匹配；裸名/slug 不区分大小写）
npm run cli -- runs list --project @sandbox   # 特殊桶选择器：@sandbox/@scratch/@unattributed（闭集，未知值报错）
npm run cli -- runs summary                 # 状态统计
npm run cli -- runs grep "error"            # 搜索 transcript
npm run cli -- runs prune --older-than 7d   # 清理 7 天前的 run
npm run cli -- runs prune --older-than 90d --archive   # 归档 90 天前的 run（移动不删除）
npm run cli -- runs settle                  # 列出没有新鲜心跳的非终态运行，逐道门给出能否结算（只读）
npm run cli -- runs settle --run-id <id> --reason-file <f> [--apply]   # 结算成 failed（process_missing）；不带 --apply 是 dry-run
```

`runs prune --older-than` 的删除判龄只读本 run 自身信封绑定事件（transcript 文件名 stem 即权威 runId）的末条 `ts`。尾部追加的外 run 或伪造旧 `ts` 的行，不会把在役 run 翻成可修剪；unlink 前被阻断。全无信封的 legacy transcript 按末事件 `ts` 照常判龄、照常参与清理。

`--archive` 把超龄 transcript 移动（而非删除）到与 runDir 同级的 `runs-archive/<yyyy-mm>/<原文件名>`。文件名原样保留——技术债与摩擦记录多以 runId 文件名为证据锚，改名即锚灭失。`<yyyy-mm>` 按判龄所用 `ts` 的月份分层，`ts` 无效或为 0 时按文件 mtime 的月份兜底。目标同名文件已存在时不移动、不覆盖，输出冲突行并计入 skipped——宁可不动，不可丢数据。判龄、扫描面（runDir 顶层与 `projects/*` 桶内的 `.jsonl`）、legacy 语义与不带 `--archive` 时完全一致。

归档后的 run 不再出现在 `runs list`、`runs metrics --summary`、`runs dashboard`、`runs grep`；按 runId 直读（status/tail/collect 等）会 ENOENT。法医取证进 `runs-archive/` 按原文件名查。

清扫 runbook（首次与例行）：

1. 跑之前停 daemon，并确认无活跃 run（`runs list` 无非终态）。被归档 run 若仍有进程在写，`appendFile` 会在 runs/ 原地重建单事件 stub，法医链断裂且下轮清扫抓不到。
2. 清扫前后各数一次 `ls runs/*.jsonl runs/projects/*/*.jsonl | wc -l`（顶层与项目桶都算），差值应与汇总行 `Archived` 数一致。库里没有超龄文件时 `Archived 0` 是正常结果，不是故障。
3. 关闭所有占用 runs/ 文件的编辑器和 tail——归档循环无逐文件容错，Windows 上文件被占用会让 rename EPERM 中断整批。已输出的 `Archived` 行即恢复痕迹，续跑即可。
4. 逐条保留输出的 `Archived ... -> ...` 行，这是唯一的迁移审计轨迹。

清扫面边界：runDir 顶层与 `projects/*` 桶内的 `.jsonl`；桶内文件归档后同样落在 `runs-archive/<yyyy-mm>/<原文件名>`，不保留桶目录。其它子目录语料（`smoke/`、`verify/`、`driver-comparison-*/`、`wao-prod-drill-*/` 等）、顶层日志（ALERTS.log、*.log）、`.owner-run_*` 标记、`reliability-summary.json` 都不在清扫面内。`runs/reliability/` 认证转录的删除走独立通道，见 `docs/certification-runbook.md`。

## 批量清退 worktree 与分支（卫生清退 SOP）

派发 advisory（worktrees/branches 计数）弹行，或 `npm run hygiene` 的 W4/W5 变红时，按本规程处置。销毁性纪律：分类清单须 Owner 点名批准后才执行删除。

五步流程：

1. 分类（只读，双证）：
   - 分界：`git branch --merged main --list "wao/run_*"`（并入=删标签零丢失）vs `--no-merged`。
   - 台账交叉：runId = 分支名去 `wao/` 前缀（含 `run_`）；转录查三处——`runs/projects/*/<runId>.jsonl`（分桶新档）、`runs/<runId>.jsonl`（旧平铺）与 `runs-archive/<yyyy-mm>/<runId>.jsonl`（归档，为什么见决定 0050）。
   - 交付判定取最后一个决定事件。转录存在多轮 repackage/correction/reverify，先拒后收的 run 按首事件判会错分类。无决定事件但有 `delivery_created` → 悬空。
   - 已接受 ≠ 已并入：squash 落地会使 `--no-merged` 误报，用 `git cherry main <分支>` 验 patch 等价性（`+` 行数为 0 = 内容已在 main）。
   - 承重引用：未并入分支 tip SHA 前 7 位 grep `docs/ .wao/decisions/ README.md`；引用是冻结文本不改写，SHA 靠 bundle 备份。
   - 双证：worker 全量扫描 + Lead 独立脚本复核，计数逐项吻合才继续。
2. Owner 批准：分类清单 + 建议处置（并入→删 / 已拒绝→bundle 删 / 悬空→Owner 裁 / 引用→Owner 裁）报批；未裁定项保守保留。
3. 保全（先于一切删除）：`git bundle create <runs-archive/<yyyy-mm>/hygiene-cleanup-<date>.bundle> <全部待删引用>`（显式清单，含引用 SHA）→ `git bundle verify` → sha256 入记录。
4. 执行（顺序不可换）：摘工作树（嵌套深度降序、最深先——套娃树先内后外；脏树先 `git status --porcelain` 快照留痕再 `--force`）→ 删分支（已并入 `-d`，git 保险丝拒未并入；未并入 `-D`，仅 bundle 之后；显式名单循环，禁 glob）→ `git worktree prune`。
5. 收口：计数闭合（前后分支/树数对账）→ `npm run hygiene` 5/5 → 清退记录落 `runs-archive/<yyyy-mm>/`（record.md + bundle + 脏树快照，磁盘档）→ 提交，经过写进提交说明。

踩坑备忘：非时间戳命名的 runId（dogfood 系）别按时间戳规则批量误伤；"已并入但台账已拒绝/悬空"的反常行单独标注、不阻塞（内容在 main 即零丢失）；`git bundle create` 的 `--version` flag 在部分 git 版本不认（省略即可）；runs/ 转录不动——清扫走「管理历史 run」的 prune --archive 通道，两套清退互不越界。

## daemon 与自愈（无人值守长跑）

daemon 是常驻派发点（detached，CLI 退出不杀它），让 worker run 脱离单次 CLI 调用存活。supervisor 给它装自愈（崩了自动重启），health 给它装可观测（长跑泄漏告警）。

```powershell
# 起 daemon（detached，幂等）。--resume-on-start：重启时接管未完成 run。
npm run cli -- daemon start --resume-on-start

# 经 daemon 派发 worker（run 归 daemon 持有 → 出现在 daemon list，可被自愈保护）。
# 优先用这个而非 `run --background`（那个不经 daemon，daemon list 看不到）。
npm run cli -- daemon run glm-flash --prompt "..."

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

自愈边界：supervisor 自身被杀（如机器重启）无法自拉——那种"重生引导"需要 Windows 服务或计划任务承载，不在当前能力内。

可观测定位：health 是眼睛（告警），不自动修泄漏根因；根因靠长跑 dogfood 暴露后针对性修。

无人值守长跑姿势：`daemon start --resume-on-start` → `daemon supervise` → 派发任务 → `daemon health` 巡检。长跑 dogfood 需要真实 token 预算，并有人盯着暴露的 bug。

## Owner 本地只读看板

人类 Owner 可在 WAO 仓库入口启动本地网页，而不把完整 worker 活动灌入 Lead context。主用命令需一次性 `npm link`，见[安装与配置](install.md)的「安装本工具」：

```powershell
# 在目标 Git 项目内（或任意目录加 --cwd 指向 Git 项目）
wao dashboard
wao dashboard --cwd "D:\path with spaces\project"   # 从任意目录启动
wao dashboard --no-open                             # 启动但不自动打开浏览器
wao dashboard --port 8123 [--run-dir DIR]           # 固定端口 / 自定义 run 目录
```

行为契约：

- 目标目录默认是当前目录（`process.cwd()`）；`--cwd` 显式指定目标项目。目标必须在某个 Git 仓库内——命令解析出 canonical Git root 作为看板 workspace（嵌套子目录也自动解析到仓库根）；不在 Git 仓库内时，在监听之前就失败，并给出可操作提示（在 Git 项目内运行，或用 `--cwd`）。
- 经全局 `wao` 调用时，看板读取的 run 目录与 agent registry 从受信安装根解析（见[安装与配置](install.md)的「安装本工具」中「共享状态解析根」），不会静默落到当前目录的 `runs/` 或 `config/`；当前目录仅作默认 target workspace（`--cwd` 可覆盖），显式 `--run-dir` 覆盖照原样使用、不被重定位。
- 默认在 Windows 默认浏览器打开生成的 fragment-token URL 恰好一次（无 shell 拼接，URL 只作为结构化 argv 传给系统默认处理器）；`--no-open` 不做任何打开尝试。打开是 spawn 型的：处理器子进程在 spawn 后即被 unref，即使默认处理器进程滞留也不会阻塞本命令的 Ctrl-C 关闭。
- 浏览器打开失败只是提示：URL 已打印，打印一行简短警告后服务器继续运行，按 `Ctrl-C` 停止。
- 已接受的瞬时本机暴露（如实披露）：生成的 fragment-token URL 会打印给人类 Owner，并会短暂出现在本地 `rundll32` 子进程的命令行中（Windows 上本机其它进程/工具可瞬时读到该命令行）——这是让默认浏览器打开该 URL 的必要传递方式。服务边界未因此改变：服务器仍只监听 `127.0.0.1`，token 生命周期随服务器关闭（Ctrl-C/进程退出）结束，看板 API 只接受带该 bearer 的只读 GET。

旧式嵌套命令仍支持（不会自动打开浏览器，非 Git 目录 fail-soft 启动）：

```powershell
npm run cli -- runs dashboard --web [--port 0|1024..65535] [--run-dir DIR] [--cwd GIT_ROOT]
```

命令打印一次 `http://127.0.0.1:<port>/#token=<64hex>` 和停止提示；在浏览器打开该 URL，按 `Ctrl-C` 关闭。省略 `--port` 时使用临时端口。`--web` 不与 `--watch` 或 `--format json` 共用。

看板展示当前 workspace 的最近 runs、状态、最后活动和有界详细消息，支持筛选、选择 run、继续读取旧页与自动轮询；移动端 recent-runs 区域独立滚动。选中 run 的详情面板给出 backend、execution stage、terminal、事件总量、scope observation、liveness 与有界活动时间线；这些均是 transcript/application projection 的只读事实，不是语义进度判断。它调用与 `run_activity` 相同的读取/分类/redaction/cursor SSOT，只使用 Owner 较大的 excerpt/page 默认值，不直接读 JSONL。

浏览器终态通知需人类显式 opt-in：只有 Owner 点击启用且浏览器授予 Notification permission 后，页面才在观察到同一选中 run 从非终态变为终态时通知恰好一次。首次加载/刷新时已终态的 run 不补发，重复 polling 不重复发送，拒绝权限会明确显示 `notifications blocked`。通知只含固定安全字段，不含 worker 消息、路径、command/tool payload、credential 或 session。所有异步 activity 请求同时绑定选中 `runId` 与 selection epoch，A→B→A 快速切换时旧响应不得覆盖当前 run 的详情。

看板默认打开 Active 模式：只列出当前有新鲜 owner 心跳、经证明 active 的 run（候选集是当前的 `.owner-*` 租约文件——候选枚举只 `readdirSync` 一次 runDir，只有当前租约候选者的 transcript 被打开/解析/验证，无任何历史 transcript 被打开/解析），每 5s 自动刷新。历史 run 仅在 Owner 显式选择 `1h`/`24h`/`7d` 预设或有界自定义 from/to（上限 7d；禁止未来/倒序/越界/未知参数，固定 400）后按需加载一次；历史模式不自动轮询。Active 响应固定标注 `scanScope=active`，且不携带 `unresolvedCount`（active scope 不做全库存 unresolved 分类，该计数恒缺失而非 0）。范围按 transcript 派生的 `updatedAt` 过滤（非文件系统 mtime），并复用长驻看板服务进程内的元数据校验 summary 缓存做热读（无第二个持久索引）。模式切换绑定 runs-mode epoch：迟到的 Active 或 History 响应不得覆盖当前模式或更新的查询；run 从 active 集或有界历史窗口中消失绝不构成终态迁移，也不触发通知。HTTP `/api/runs` 的 `scope` 为闭集 `{active,history}`、缺省即 active；MCP `runs_list` 与 CLI 文本看板行为不变（仍是全库存扫描 + `unresolvedCount`）。

席位看板（board）视图是 mode-bar 上 `list ⇄ board` 的纯呈现切换：消费同一份当前 scope 的 `/api/runs` 数据（不重发请求、不重置已选窗口、不动选中 run）。board 按 agentId 分组为席位泳道：席位名 + 固定身份色轨（确定性调色板：同席位跨刷新同色、同屏可见席位互不同色；色轨只是装饰性强化，身份由席位名文字承载）+ run 卡片（状态芯片 + 相对时长 + runId 尾段，点击复用既有详情面板）；非终态 run 靠前强调、终态弱化；泳道按席位最新活动排序（平局按 agentId 字典序），无手动排序。诚实契约：board 顶部常驻当前 scope 标签与窗口截断提示（matched vs returned），并常驻一句提醒——窗口内无 run 不代表该席位空闲；agentId 未过 registry 校验（或席位已移除）的 run 归入显式 unknown 泳道（置底、注明是数据限制、非真实席位、不占调色板槽位）。看板服务端按 registry 解析席位 id；registry 损坏或单条畸形时软降级为 unknown，不崩。无障碍：身份/状态不只靠颜色区分、卡片为真实按钮可键盘操作且有可见焦点、正文文字对比度 ≥4.5:1（测试实测钉住）；窄视口下泳道区内部滚动（与列表同界）。

安全边界：服务只监听 `127.0.0.1`，API 要求每进程随机 bearer；token 只从 URL fragment 进入 `sessionStorage`，不进 query/server log/localStorage。服务仅接受 GET 和严格有界 query，固定静态资源、no-store/nosniff/no-referrer、严格 CSP、无 CORS opt-in。页面没有 mutation 控件：不会 stop/retry/continue/repackage/decide，也不会写 transcript、worktree 或配置。Owner 视图仍会隐藏 credential/secret、raw command/tool payload、PID/session/绝对路径；其余 worker 消息按 Owner 观察用途提供较丰富但有界的脱敏文本。

## worktree 清理失败（Permission denied）

Windows 文件锁问题。WAO 已内置 fallback（rmSync + git worktree prune）。若仍有残留：

```powershell
git worktree prune
git worktree remove --force .wao-worktrees/<runId>
```
