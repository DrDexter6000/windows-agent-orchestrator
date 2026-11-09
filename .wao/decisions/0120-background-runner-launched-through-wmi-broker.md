# 0120 后台 runner 经 WMI 起的启动桥启动，不随宿主重启 MCP 服务而死

- 日期：2026-11-09
- 状态：accepted
- 来源：台账 TD-347（宿主项目收件箱 fb_20261109T125706Z_jpfczh）；第 93 批。方案经 kimi、sol 两席方案审查（都判 REVISE，改法一致）。

## 背景

实测（Claude 桌面版 4.23118，WMI 进程记录器）：

1. 宿主把每个 WAO MCP 服务放在只有 `KILL_ON_JOB_CLOSE`（`LimitFlags=0x2000`）的作业里。一次 MCP 请求超时后，会话的下一次调用让宿主重启服务：服务、它派发的后台 runner 与 runner 之下的全部进程 3 毫秒内一起退出，没有 `taskkill`。
2. 这个作业不允许脱离：带 `CREATE_BREAKAWAY_FROM_JOB` 的 CreateProcess 报 err=5。
3. 经 WMI `Win32_Process.Create` 起的进程（父进程 `WmiPrvSE.exe`）落在另一个作业（`0x1800`，无 kill-on-close，无内存与进程数上限），服务重启后存活；与调用者同会话、同用户，`taskkill /T /F` 能结束它。
4. 一个 MCP 服务由多个 Code 会话共用，一个会话的超时会带走别的会话、别的项目的 worker。

合入（df75aded）后在真实宿主上验证：经新代码的 MCP 服务派发的运行，runner 的父链是 服务 → PowerShell → `WmiPrvSE.exe` → 启动桥（已退出）→ runner；随后一次请求超时让宿主重启服务（服务进程退出），runner 与其下的 dsh、keep-awake 进程都活着，运行照常跑到 `run.completed`。

## 决定

1. 三处起后台 runner 的地方（派发、续修、resume 接管）共用一个启动模块。Windows 上的缺省路径：父进程开一次性命名管道（名字带 128 位随机数，只接受第一个连接），经 PowerShell 调 WMI 起一个短命的启动桥（命令行只有 node、桥脚本、管道名、`--run-id` 与一次性 nonce，不带凭据与 runner 的长 argv）；桥连上后先发 nonce，父端核对一致才发一帧载荷 `{execPath, args, env, cwd, prompt, stderrPath, deadlineAt}`（上限 4 MiB）；桥在期限内按原来的形状起 runner（env 在创建进程时生效、提示词经 stdin、stderr 落 `.runner-<runId>.stderr`），回 `{runnerPid, handoff}` 后退出。node 的管道缺省 DACL 给 Everyone 读权限、名字又能被列举，nonce 挡住别的账户只读连上拿走载荷（它们读不到他人进程的命令行）。
2. 不自动退回由本进程直起：WMI 起不了时按启动失败收口，报错原文点名开关。`WAO_RUNNER_LAUNCH=spawn` 显式改回直起（runner 又会随服务重启而死）；非 Windows 与注入 `spawnFn` 的测试也走直起。canonical 测试的子进程环境钉 `spawn`，只有本批的启动测试走 WMI。
3. 不得有第二个 runner：载荷已发出而结果不确定（回帧丢失、回帧坏、提示词交接超时）时，先按已知 pid（桥、runner）结束进程树，再按命令行带 `--run-id <runId>`、创建时间不早于本次启动的 node 进程扫描并结束，再扫一次；已知 pid 都不在且第二次扫描无命中才算确认，确认了才走各调用方原有的启动失败收口。没能确认（`runner_kill_unconfirmed`）时运行保持 pending、写 `run.error`，续修不回滚，交给 `wao runs settle` 判定。一个总期限覆盖起桥到回帧（沿用提示词交接的 30 秒），结束阶段另有 15 秒预算。

## 被否方案

- **runner 自己连管道并替换 `process.env`**：import 时就读环境的模块会拿到 WMI 进程的缺省环境；桥在创建 runner 时就把 env 交进去，runner 不用改。
- **cmd 包一层做 stderr 重定向**：多一个进程，退出码、租约 pid、进程扫描都要另外认它；桥直接交文件句柄，与原来一样。
- **一次性临时文件交接载荷**：凭据会落盘。
- **WMI 起不了时自动退回直起**：静默地失去这次修复的保护；改为响亮失败加显式开关。
- **常驻启动代理或由 daemon 代起**：多一个要管生死的常驻进程。

## 已知局限

- 同用户进程能读到桥的命令行（含 nonce），可以抢先连上冒充桥；同用户进程本来就读得到用户环境里的凭据，不再加防护。别的账户抢占管道只能让这次启动失败（`bridge_unverified`），拿不到载荷。
- 每次起 runner 多一次 PowerShell 启动（约 1 秒）。载荷上限 4 MiB 只在 WMI 路径上有，超了按启动失败（`payload_too_large`）。
- 全量测试钉 spawn，WMI 路径只由本批的启动测试证明；本机 WMI 被拒时作业测试会跳过，验收时要看它是通过还是跳过。
- kimi serve、空闲看护与 keep-awake 是 runner 的后代，随 runner 一起脱离；合入前起的 serve 仍在旧作业里。repackage/reverify 的验证仍跑在 MCP 服务进程里，服务没了照 0119 由 Lead 再调。
- 合入前已在跑的 MCP 服务仍用旧代码直起 runner；合入后重启各宿主的 WAO MCP 服务。
