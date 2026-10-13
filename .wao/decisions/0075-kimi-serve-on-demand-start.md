# 0075 kimi worker serve 按需拉起：派发时发现 serve 没在跑就自动启动（车道声明 serveWorkspaceDir）

- 日期：2026-10-13
- 状态：accepted（Owner 2026-10-13 指令，原话见"来源"；具体做法由 Lead 在既有授权下确定，与 Owner 的字面建议有一处不同，见"为什么是派发时"）
- 来源：Owner 2026-10-13 对决定 0074 收尾报告的回复（原话）——"3、启动kimi serve不能lead agent自动化？必须人类用户手动？需要我授权还是别的什么技术原因？这不科学 4、wao serve start加开机自启我不太建议，总之我作为人类用户很讨厌任何开机自启的应用，我还是建议由随lead agent的harness启动（应该所有其他常规mcp都是如此？）"。此前的授权（同日）："我授权和同意你基于会审意见、你作为lead agent的最终决断来做出必要的动作、以达到我们追求的目标目的"。
- 关系：决定 0056（serve 维护族"不挂 daemon、无自动触发"）；决定 0058 / 0063（recycle 的环境纪律、死实例复活、exe 候选链）；决定 0074（私有主目录、剔密钥类变量、手动启动脚本）；决定 0047（`WAO_IN_WORKER` env 臂）。
- 会审：见文末"会审"。
- 合入授权：Owner 2026-10-12——"只要是你联合会审过的，我都许可 commit & push"。

## 背景与实测

重启机器后 kimi 的 worker serve 不在，kimi 车道报连接被拒。决定 0074 的收尾把这件事写成"需要人手动拉起"。这没有技术障碍，也不需要额外授权——只是没有做成自动的。

实测（2026-10-13，kimi 2.1.1，Node 22，本机）：

| 启动方式 | serve 在拉起它的进程退出后 | worker 跑命令时的可见窗口 |
| --- | --- | --- |
| Node `spawn`，`detached: true, stdio: "ignore"`（recycle 一直用的形状） | 继续运行 | 0 |
| Node `spawn`，只给 `windowsHide: true`、不给 `detached` | 消失（之后十几秒里六次探测全部连接被拒，进程不在） | 没测到这一步 |
| PowerShell 脚本 `scripts/kimi-serve.ps1`（隐藏窗口） | 继续运行 | 0 |

"可见窗口"的量法：让 kimi worker 跑一条 14 秒的 `ping`，同时每 0.4 秒枚举 serve 的全部后代进程（实见 `bash.exe`、`conhost.exe`、`PING.EXE`），查有没有哪个持有可见的顶层窗口。只覆盖了 shell 命令这一种工具。

冷启动到会话面应答：约 2 秒（两次拉起，各 2 秒）。

## 决定

1. **kimi-web 车道可声明 `serveWorkspaceDir`**（绝对路径，worker serve 的工作目录）。声明后，每次派发（含续接轮）在建会话之前先探一次 serve：连接被拒 → 以该目录为工作目录拉起 `kimi web --no-open --port <serveUrl 的端口>`，等到有应答再继续；有任何应答（含鉴权失败、超时）→ 不动，照常由请求路径报错。没声明的车道行为不变，连探测都不发。
2. **只在回环地址上拉。同一端口同时只有一个进程在拉**：系统临时目录下按端口的锁文件，120 秒陈旧界；没拿到锁的派发只等。等待上界 45 秒。
3. **启动原语只有一份**：exe 候选链、工作目录的形状门与放置门（不在 `.wao-worktrees` 下、不在 kimi 主目录内、不在任何 git 工作树内）、环境组装（`WAO_IN_WORKER=1` 恒注入、`KIMI_CODE_HOME` 按车道、剔密钥类变量）、detached spawn 与 'error' 仲裁，从 recycle 的重启段迁到 `src/backends/kimiServeStart.js`，recycle 与按需拉起共用。recycle 的行为不变（既有测试原样通过）。
4. **Lead 看得到**：本次派发拉起过 serve，或等过别的派发拉起，转录的第一条是 system 说明（pid、等了几秒）。拉不起来，派发在建会话之前以固定文案失败，点名原因（工作目录不对、找不到 kimi 可执行文件、起了但 45 秒没应答等）。
5. **不做**：开机自启、常驻守护进程、harness 启动时预拉、空闲自动关闭、自动 recycle / sweep。

## 为什么是"派发时"，不是"harness 启动时"

Owner 的建议是跟着 Lead 的 harness 启动。两种做法对用户的效果相同：不用人动手，也没有开机自启。取"派发时"的理由：

- 不是所有派发都经过 MCP server 的启动：命令行派发（`wao run`、会审）没有这一步。
- 没用到 kimi 的会话不会平白起一个 serve。
- serve 中途没了（被关、崩溃），下一次派发自己补上。

差别有一处：serve 不随某个 harness 退出而关。它是各 Lead 宿主共用的，一个宿主关掉时别的宿主可能有在途的 kimi 运行。

## 与决定 0056 的关系

0056 定的是 serve 维护"不挂 daemon、无自动触发"，理由两条：worker serve 全机共享、归属含糊；自动重启时环境组装出错，会让 0047 的 env 臂静默失效。

本决定只放开一件事：**端口上没有监听时把 serve 拉起来**。这时没有会话可保护，也没有别的实例会被误伤；环境由唯一的一份原语组装，`WAO_IN_WORKER=1` 恒注入并有测试钉住。关、重启、清扫仍然只有手动命令——那些才是 0056 担心的动作。

## 本机配置（不在仓库里）

`config/agents.json` 的 kimi 车道加 `serveWorkspaceDir = D:\projects\.kimi-serve-worker-ws`。合入之后执行。

## 行为变化与如实边界

- **声明了 `serveWorkspaceDir` 的车道，每次派发多一次回环请求**（探测）。
- **serve 继承拉起它的那个进程的环境**，去掉密钥类变量。哪个 Lead 宿主派出的那一单把 serve 拉了起来，serve（以及此后所有 worker 的工具进程）就带着那个宿主会话的非密钥变量，例如宿主自己的会话标记。手动脚本另外去掉了 `CLAUDE*` / `ANTHROPIC*`；按需拉起没有这一步。没有发现由此造成的功能问题（worker 里的嵌套派发由 `WAO_IN_WORKER` 拦住），但 serve 的环境因此取决于"谁先派"。
- **锁是尽力而为**。持锁进程崩了，120 秒后才有人接手；陈旧锁被两个进程同时接手时会各拉一次，后到者绑不上端口——kimi 此时的表现没有测。锁文件写不了（临时目录异常）时不挡路，直接拉。
- **端口被别的主目录的 serve 占着**：探测得到的是鉴权失败，算"有应答"，不拉；派发照旧以鉴权错误失败。
- **serve 的寿命**：拉起后一直运行到关机，或有人手动 shutdown / recycle。Lead 宿主退出后 serve 是否存活没有实测（它与 runner 用同一种 detached 方式启动，设计上不依赖宿主）；即便被带走，下一次派发会再拉。
- **窗口**：这样拉起的 serve 没有控制台，worker 的工具进程由 kimi 自己创建。实测一条 shell 命令没有可见窗口，没有覆盖别的工具类型。
- **首次使用的私有主目录**（还没有 `server.token`）不在此列：token 文件缺失时派发在更早处就拒绝了（决定 0074），不会去拉 serve。
- **尚未重启的 Lead 宿主**：派发由新起的 runner 进程执行，runner 加载的是磁盘上的代码，所以旧宿主的派发同样会走到按需拉起；旧代码的注册表校验不认识新字段，但也不拒绝未知字段。这一条在合入前没法实测（宿主跑的是主检出）。
- **`serve recycle` 仍然要显式给 `--workspace-dir`**，没有改成缺省取车道的 `serveWorkspaceDir`。

## 验证

| 项 | 结果 |
| --- | --- |
| 单测 `test/backends/kimiServeStart.test.js`（新，5 例；fetch / spawn / 睡眠 / 时钟全注入，零真进程）：有应答、没声明工作目录、非回环地址 → 不动；连接被拒 → 拉起一次（参数、工作目录、环境、detached）并放锁；别人持锁 → 只等；陈旧锁 → 接手；拉不起来的六种原因 → 固定文案、不含 token、锁不残留；有应答但不认 token → 数拍后交回 | 通过 |
| 单测 `test/backends/kimiWeb.test.js` 0075 例：没声明不调；声明了在任何会话请求之前调一次；拉起过 / 等过 → events 第一条是 system 说明；拉不起来 → 派发失败且零会话请求；字段形状在 registry 与 backend 同一判据 | 通过 |
| 既有 recycle 测试（`serveMaintenance.test.js` 18 例、`serveReviveAndHusk.test.js` 9 例）在启动原语迁移后原样运行 | 通过 |
| 真机，分支代码 + 注册表临时副本（加了 `serveWorkspaceDir`）：先优雅关掉 serve，再派一条 kimi 任务 | serve 被拉起（2 秒后应答），任务 19 秒完成，转录第一条是说明；派发进程退出后 serve 仍在 |
| 真机，同上：serve 关着时同时派三条 | 一条拉起、两条等待（各 2 秒），三条全部完成；之后 kimi serve 进程 1 个、端口监听 1 个、锁文件 0 个 |
| 全量 `npm test` | 见提交说明 |

## 会审

见提交说明（会审在首个提交之后进行，结论与处置补在这里）。

## 登记未改

- serve 的环境没有去掉 Lead 宿主的会话变量（见"如实边界"第二条）。
- 没有做 `wao serve start` 命令：按需拉起已覆盖"不要人工"的需求，手动路径保留 `scripts/kimi-serve.ps1`。
- 没有做空闲自动关闭。
- `serve recycle` 的 `--workspace-dir` 没有缺省取车道字段。
- Lead 宿主退出后 serve 是否存活、非 shell 工具是否弹窗、MCP 路径（未重启的宿主）——没有实测。
