---
read_when: 清理历史 run 与工作树、daemon、Owner 看板
---
# 维护

> [使用手册](../usage.md)

## 管理历史 run

```powershell
npm run cli -- runs list                    # 列出所有 run + 状态
npm run cli -- runs list --project <路径|裸名> # 按项目过滤（路径=键精确匹配，链接工作树路径选主工作树的项目；裸名/slug 不区分大小写）
npm run cli -- runs list --project @sandbox   # 特殊桶选择器：@sandbox/@scratch/@unattributed（闭集，未知值报错）
npm run cli -- runs summary                 # 状态统计
npm run cli -- runs grep "error"            # 搜索 transcript
npm run cli -- runs prune --older-than 7d   # 清理 7 天前的 run
npm run cli -- runs prune --older-than 90d --archive   # 归档 90 天前的 run（移动不删除）
npm run cli -- runs settle                  # 列出没有新鲜心跳的非终态运行，逐道门给出能否结算（只读）
npm run cli -- runs settle --run-id <id> --reason-file <f> [--apply]   # 结算成 failed（process_missing）；不带 --apply 是 dry-run
npm run cli -- runs lineage-close --run-id <id> --reason-file <f> [--apply]   # 关闭续修谱系、按门释放保留的树（不删分支，不释放会话）；不带 --apply 是 dry-run
```

`runs settle` 的进程扫描也认前台 `wao resume <runId>`：带 `--run-id`、`--resume-run-id` 或 `resume <runId>` 的进程都算 runner 还活着，结算即拒。后台运行的扫描对读不到命令行的 node 进程按创建时间收窄（早于派发的不计），前台运行不收窄。会话取不出本机 pid 时，本机开机晚于该运行最后可见活动即放行（`session_rebooted`）。

`runs prune --older-than` 的删除判龄只读本 run 自身信封绑定事件（transcript 文件名 stem 即权威 runId）的末条 `ts`。尾部追加的外 run 或伪造旧 `ts` 的行翻不动在役 run；无信封的旧转录按末事件 `ts` 判龄。runDir 下的 `.runner-<runId>.stderr` 先于转录删除或归档，删不掉、移不动或目标已存在时这一对都不动。

`--archive` 把超龄 transcript 移动（而非删除）到与 runDir 同级的 `runs-archive/<yyyy-mm>/<原文件名>`。文件名原样保留——技术债与摩擦记录多以 runId 文件名为证据锚，改名即锚灭失。`<yyyy-mm>` 按判龄所用 `ts` 的月份分层，`ts` 无效或为 0 时按文件 mtime 的月份兜底。目标同名文件已存在时不移动、不覆盖，输出冲突行并计入 skipped——宁可不动，不可丢数据。判龄、扫描面、legacy 语义与不带 `--archive` 时完全一致。

归档后的 run 不再出现在 `runs list`、`runs metrics --summary`、`runs dashboard`、`runs grep`；按 runId 直读（status/tail/collect 等）会 ENOENT。法医取证进 `runs-archive/` 按原文件名查。

清扫 runbook（首次与例行）：

1. 跑之前停 daemon，并确认无活跃 run（`runs list` 无非终态）。被归档 run 若仍有进程在写，`appendFile` 会在 runs/ 原地重建单事件 stub，法医链断裂且下轮清扫抓不到。
2. 清扫前后各数一次 `ls runs/*.jsonl runs/projects/*/*.jsonl | wc -l`，差值应与汇总行 `Archived` 数一致。库里没有超龄文件时 `Archived 0` 是正常结果，不是故障。
3. 关闭所有占用 runs/ 文件的编辑器和 tail——归档循环无逐文件容错，Windows 上文件被占用会让 rename EPERM 中断整批。已输出的 `Archived` 行即恢复痕迹，续跑即可。
4. 逐条保留输出的 `Archived ... -> ...` 行，这是唯一的迁移审计轨迹。

清扫面边界：runDir 顶层与 `projects/*` 桶内的 `.jsonl` 及随其处置的 `.runner-<runId>.stderr`；桶内文件归档后同样落在 `runs-archive/<yyyy-mm>/<原文件名>`，不保留桶目录。其它子目录语料（`smoke/`、`verify/` 等）、顶层日志（ALERTS.log、*.log）、`.owner-run_*` 标记、`reliability-summary.json` 都不在清扫面内。`runs/reliability/` 认证转录的删除走独立通道，见 `docs/certification-runbook.md`。

## 批量清退 worktree 与分支（`wao worktree reclaim`）

派发 advisory 弹行，或 `npm run hygiene` 的 W4/W5 变红时，按本规程处置。符合条件的干净 `persistent` 树终态已自动释放、分支一律保留（`docs/02-architecture.md` §4.3，决定 0085），本节清退的是残留树与分支。

每批收尾三步：合入 → 有交付的每一轮都记裁决（被新派修正轮取代的前几轮也要；续修谱系只裁决最终候选；无交付的不裁决）→ 按本节回收。合入尽量快进或合并以保留原交付提交；在 main 上重建、或验证失败后采纳的，按 delivery 页「验证失败采纳协议」写 `WAO-Adopted-From` 与 `WAO-Original-Delivery` trailer，文档记落地提交的 SHA——分支未并入 main 时，文档里记它的短 SHA 会让它落进 `include_required`、回收不掉。

四步：

1. 生成计划（只读）：`npm run cli -- worktree reclaim --cwd <repo> --out <plan.json> [--run-dir DIR] [--include <runId>]...`，打印计划 sha256、可照抄 apply 命令、分类计数与逐条回收项的审批事实（嵌套项另打目标与父树）；不传 `--run-dir` 时缺省安装根的运行目录。
2. 审阅与判定：谁判定、哪些要用户同意，见 `docs/02-architecture.md` §4.3「人工清退」。`include_required` 类保留项（未并入 main，且 tip 短 SHA 被 docs/`.wao/decisions/`/README 引用或只有分支没有树且三处无转录）判定可以回收的，带 `--include <runId>` 重新生成计划。
3. 执行：`npm run cli -- worktree reclaim --apply <plan.json> --expect-sha256 <hex> [--run-dir DIR]`。apply 重核仓库与计划绑定，一律用计划里的运行目录（不一致拒绝）；分支先进 bundle（完整历史，list-heads 含 tip）；树逐棵复核：嵌套项先重证范围（父树在册同仓、路径未变、无链接；旧形状不动）、内容指纹、逐成员现读转录后才摘，ref 比对后才删；删前对依赖被取代放行者按现状重证、其余已打包成员复核（裁决/线系/被取代三条都不满足才跳过：`delivery_packaged_undecided_now`；枚举不完整时计划不出删除项、执行跳过）；记录（计划副本、逐项结果、快照、bundle sha256）落 `<runs 同级>/runs-archive/<yyyy-mm>/worktree-reclaim-*/`，成败都落；记录写失败、目录缺失或删分支时登记读不出以非零退出码结束并列出已删部分。
4. 收口：`npm run hygiene`。

清退范围：主检出与每个经核验的关联工作树（在册、同 common git dir、目录在、路径无链接/junction）下各自的 `.wao-worktrees/` 一级 `<runId>` 子目录；嵌套项在计划里记范围证明（父树、common git dir、目标真实路径）。

一律保留的形态（闭集，见计划与命令输出）：事实读不出或身份无法唯一判定；范围外路径（源工作树、关联工作树本身、符号链接/junction、外仓 worktree）；运行中（非终态/近期 worker 或 WAO 事件/新鲜心跳；Lead 的裁决、谱系关闭与收集不算）；交付未收口；复用线系未闭合；未裁决（已打包未决——已被取代的祖先除外——或树脏）；头指针漂移；嵌套保留；只读 run 留下的私有克隆（`private_clone`）。已并入 main 的分支不做引用检查（提交仍从 main 可达）。已裁决或线系已关的脏树删前存补丁与未忽略新文件的副本（记录的 `dirty/`），被忽略的文件不存，计划仍标"删除即丢弃未提交内容"；备份失败、超 256 MiB、树里有目录链接时保留。runs/ 转录不动——清扫走上方 prune --archive 通道，两套清退互不越界。

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
npm run cli -- daemon health               # 最新采样；daemon 未运行、采样过旧或时间戳异常时 level=stale（原因见 staleReason），原结论在 lastSample

# 停 daemon（IPC shutdown）
npm run cli -- daemon stop
```

自愈边界：supervisor 自身被杀（如机器重启）无法自拉——那种"重生引导"需要 Windows 服务或计划任务承载，不在当前能力内。

可观测定位：health 是眼睛（告警），不自动修泄漏根因；根因靠长跑 dogfood 暴露后针对性修。

无人值守长跑姿势：`daemon start --resume-on-start` → `daemon supervise` → 派发任务 → `daemon health` 巡检。长跑 dogfood 需要真实 token 预算，并有人盯着暴露的 bug。

## Owner 本地只读看板

人类 Owner 可在任意目录打开本地只读网页，而不把完整 worker 活动灌入 Lead context。主用命令需一次性 `npm link`（步骤见 `AGENT_ONBOARDING.md` §4a；`npm link` 后全局 `wao` 的安装根解析见[安装与配置](install.md)的「安装本工具」）：

```powershell
wao dashboard                                       # 复用本运行目录的常驻实例，没有就拉起，然后打开浏览器
wao dashboard --cwd "D:\path with spaces\project"   # 打开时预选这个项目
wao dashboard --no-open                             # 只打印一次性链接
wao dashboard status                                # 查看实例；stop 停止，restart 重启
wao dashboard --port 8123 [--run-dir DIR]           # 固定端口 / 自定义 run 目录
```

行为契约：

- 每个运行目录一个常驻实例（决定 0131 第 2 条）。`wao dashboard` 先核对已在跑的实例：协议、pid 与创建时间、端口归属、`/health` 的 nonce、运行目录，全对就复用；没有或确定已失效才经 WMI 拉起。命令随即退出，实例留在后台；不开机自启，不闲置退出。看板覆盖运行目录里的全部项目，`--cwd` 指到其中某个已知项目时链接带上项目筛选，不要求 Git 仓库。
- 经全局 `wao` 调用时，看板读取的 run 目录从受信安装根解析（见[安装与配置](install.md)「安装本工具」一节的受信安装根段），不会静默落到当前目录的 `runs/`；显式 `--run-dir` 照原样使用。
- 打开的链接是 `http://127.0.0.1:<port>/v2/#code=<一次性码>`（URL 只作为结构化 argv 交给系统默认处理器，不经 shell）。码 60 秒内有效、只能用一次；页面先清掉片段，再凭码换会话令牌（24 小时，实例重启即失效）。过期就再运行一次 `wao dashboard`。`--no-open` 或打开失败时把链接打印一次。
- `status` 打印 pid、端口、启动时间、协议、build 与健康，不打印码与令牌。`stop` 请实例自己退出，10 秒没退出就如实报错，不强杀、不删记录。`restart` 确认旧实例退出后才拉起。实例运行的代码与当前不同时，`wao dashboard` 提示 restart。
- 状态放在 `%LOCALAPPDATA%\wao\dashboard\`，目录只许当前用户访问，核对不过就拒绝使用。
- 已接受的瞬时本机暴露：一次性码会出现在 `rundll32` 打开器的命令行和浏览器的这一条历史里。同一 Windows 账户下的程序不防。
- 145b 之前用 `wao dashboard` 起的前台看板没有实例记录，新命令看不见也停不了它，关掉那个窗口即可。
- `/` 与 `/index.html` 302 到 `/v2/`。`runs dashboard --web` 已退役（第 145a 批）：带 `--web` 时报固定文案并指向 `wao dashboard`；不带 `--web` 的文本仪表盘不变。

看板三页：Overview、Workers、Attention，中英文。Workers 的侧栏有 Activity、Deliverable、Brief 三个页签，Activity 经 `/api/worker/stream` 实时接收新事件，连不上时退回 5 秒轮询（决定 0132）。页面经 `/api/session` 兑换启动码，此外只读 `/api/overview|workers|attention|worker|worker/activity|worker/event|worker/stream|artifact`，都是只读事实，不是语义进度判断。

安全边界：loopback + 会话令牌 + GET-only、固定静态资源与 no-store/nosniff/no-referrer/严格 CSP/无 CORS opt-in、页面无 mutation 控件（不会 stop/retry/continue/repackage/decide，也不写 transcript、worktree 或配置）；启动码只走 URL 片段与兑换请求的 `Authorization` 头，会话令牌只存 `sessionStorage`，都不进 query/server log/localStorage。动态文本先脱敏、清控制字符、限长；工作树外的路径不显示（决定 0131 第 3 条）。分层合同见[架构](../02-architecture.md) §1 的可观测性条。

## worktree 清理失败（Permission denied）

Windows 文件锁问题。上了锁（`git worktree lock`）的树 WAO 一律不删，确要删先 `git worktree unlock`。WAO 已内置 fallback（rmSync + 定向清本树登记；无仓库级 prune——与并发 `worktree add` 有竞争）。若仍有残留，先确认此刻没有 WAO 派发在进行、`runs list` 也无非终态（前台 `run` 先建工作树、后写首条转录，建树那一刻 `runs list` 看不到它——防的就是上面那处竞争），再手工清（别用 git 的 `--force`：它跟进 junction 删树外文件）：

```powershell
git worktree prune --expire 10.minutes
wao worktree remove .wao-worktrees/<runId>
```

只读 run 的私有克隆不在 worktree 登记里，上面两条与 `wao worktree remove` 都不删它。直接删目录之前确认三件事：`git -C <克隆> rev-list --all HEAD | git -C <源仓> cat-file --batch-check` 两条命令都没有报错，输出里没有 `missing` 行（有就是源仓缺的提交；它连 stash 也查，比决定 0102 的自动检查更保守）；`git -C <克隆> worktree list` 只列出克隆自己；`git -C <克隆> status --short` 里没有要留的改动（删目录会一并丢掉）。
