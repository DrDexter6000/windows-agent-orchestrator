# 13 · P3 daemon/IPC 实测（2026-06-25）

> 类别：**调研（Research）**，早期草稿。本文记录 M7/P3 的两个 open question 的实测结果，
> 不维护事实——结论收敛后（owner 拍板 IPC 选型）权威进 ADR，本文定格为研究快照。
> 对应 open question：`docs/02-architecture.md:636,640`；M7 大纲：`docs/archive/m7-phases.md` P3 step 1。

## 背景：为什么先做 spike 而不是直接写 daemon

P3 是 M7 风险最高的 phase（新进程模型 + Windows 长跑）。按决策 0009 的纪律（"异常结果
+ 领域常识矛盾 → 先怀疑证据链、先抓原始数据，不臆断"），两个 open question 必须先实测，
不能在 spec 里拍脑袋。实测脚本在 `.dev/probe/`（gitignored scratch）。

---

## T0a · Windows detached 进程存活机制（解 open question §10:636）

**问**：detached 子进程在 Windows 上能不能真正"后台"——父进程（CLI 命令）退出后存活，
且被**后续的、独立的** CLI 调用重新触达？

**测法**（`.dev/probe/p3-{spawn,daemon,reattach}.mjs`）：
1. `p3-spawn.mjs`：`spawn(process.execPath, [daemon], { detached:true, stdio:'ignore', windowsHide:true })`
   后立即 `child.unref()` 并 `process.exit(0)`——模拟 CLI 命令派发完即返回。
2. `p3-daemon.mjs`：写 handshake `{pid, startedAt, counter}`，每 500ms 自增 counter + 追加 heartbeat 行。
3. `p3-reattach.mjs`：**独立进程**，间隔读取 handshake，断言 counter 在推进（=存活且可读）；
   再写 stop sentinel 文件，断言 counter 停止推进（=daemon 优雅退出）。

**实测结果**（2026-06-25，Node v24.13.1，Win10 26200）：
```
spawn: pid=50088 detached=true stdio=ignore
（spawner exit 0，child unref）
3s 后 reattach（独立进程）: ok=true, counter 23→26, uptimeMs=13511   ← 存活 + 可读
27s 后 reattach checkstop:  ok=true, counter 51→54, exitedOnStop=true ← 信号可达 + 优雅退出
stop sentinel 后: heartbeat 末行 "STOP_SENTINEL seen -> exit 0"
进程清理核验: pid 50088 NOT found（无孤儿）                            ← 06-18 教训
```

**结论（硬数据）**：
- ✅ `spawn({detached:true, stdio:'ignore'}) + unref()` 在 Windows 上给出**真正的后台存活**——
  父进程退出后子进程继续，且能被**后续独立进程**经 handshake 文件触达 + 停止。
- ✅ **不需要 nohup 式包装，也不需要 OS 级 service/daemon**。Node 的 detached + unref 就是
  WAO 所需的"持久 daemon"的最小机制——daemon = 一个常驻 detached runner 进程 + 一个
  handshake/pidfile + 一个 IPC 触达点。
- ✅ 与 P2 的 `src/backgroundRunner.js` 是同一族机制：P2 的 detached runner 已经用了
  `spawn(detached:true, stdio:'ignore')`，**P3 daemon = 把 P2 runner 从"一次任务"常驻化 +
  加 IPC**。P2 是 P3 的最小前身，架构连续，无返工。

**代价/边界（如实记）**：
- detached 进程没有父，**自己崩了没人知道**——daemon 必须自写 watchdog（心跳超时自重启），
  或由 CLI 在重连时发现"handshake 心跳停了"判活。这是 P3 daemon 设计必须含的一环，
  不是可选项（否则就是 06-18 孤儿问题的换皮）。
- Windows 不给 detached 子进程 SIGHUP 之类信号优雅退出——靠 sentinel 文件 / IPC 命令退出。
  实测 sentinel 文件法可靠（本 spike 验证）。

---

## T0b · IPC 选型（解 open question §10:640）—— owner 决策点

**问**：daemon 的 IPC 用**命名管道**还是**本地 HTTP**？两者都零依赖（node:net / node:http 内建）、
都 ESM 友好、都 Windows 可用——所以取舍是结构性的，不是"能不能用"。

**测法**（`.dev/probe/p3-ipc-{pipe,http}.mjs`）：各起 server，client 连发 3 次 round-trip，量 RTT。

**实测结果**（2026-06-25）：
| 候选 | 可用 | RTT (3 次) | 协议形态 | 端口/冲突 | 跨进程寻址 |
|------|------|-----------|---------|----------|------------|
| A. 命名管道 `\\.\pipe\wao-daemon` (`node:net`) | ✅ | ~1ms (1.25/1.00/0.96) | JSON-line over stream | 无端口，固定管道名 | 管道名（无分配问题） |
| B. 本地 HTTP `127.0.0.1:<PORT>` (`node:http` + `fetch`) | ✅ | ~15ms (14.8/13.6/17.0) | 请求/响应，原生 fetch | 需选端口（冲突/分配） | host:port（需发现） |

RTT 差异对**人节奏的 CLI**（每次命令间隔秒级）完全无感——**不是决策因子**。决策因子是结构权衡：

**A 命名管道 — 优点**：
- 固定名称 `\\.\pipe\wao-daemon`，**无端口分配/冲突**（WAO 已有 `portAllocator`，但 daemon
  自身不该再占一个端口给 IPC——pipe 名是确定字符串，CLI 直接连）。
- 进程边界天然：管道是本机 IPC，**不可被远程触达**（HTTP 即便绑 127.0.0.1 仍是 socket，
  需额外鉴权才安全）。
- 与"控制平面 IPC"的语义最贴合（不是 web 服务）。

**A 命名管道 — 代价**：
- 协议是裸 stream，**得自己定 JSON-line 帧格式**（本 spike 已验证可行：`\n` 分隔 JSON）。
- `node:net` 的 pipe 客户端/服务端 API 比 fetch 啰嗦——但 WAO 的 daemon 协议就那几条命令
  （list/status/start/stop/tail），手写帧的成本低且一次性。
- 调试不直观（不能 `curl`）——可提供一个 `wao daemon ping` 子命令兜底。

**B 本地 HTTP — 优点**：
- 客户端用原生 `fetch`（Node 18+ 全局可用），**代码最短**；可 `curl` 调试。
- 协议成熟（请求/响应/状态码/streaming via SSE）。

**B 本地 HTTP — 代价**：
- **必须选端口**——要么固定（多实例/占用冲突），要么动态 + 写端口发现文件（多一层状态）。
  这把 `portAllocator` 的复杂度从"worktree 端口"蔓延到"daemon IPC 端口"。
- 即便绑 127.0.0.1，仍是 socket——**安全门面更大**（同机任何进程都能连）。需要 token 鉴权，
  又多一层状态（token 存哪、怎么轮换）。

**本 spike 的推荐（供 owner 拍板，不替 owner 决定）**：**倾向 A 命名管道**。
理由排序：(1) 无端口分配 = 少一个状态源（WAO 已有 run/transcript/worktree 三类状态，IPC
不该再添端口状态）；(2) 不可远程触达 = 安全门面更小，无人值守场景（P3 目标）更稳；
(3) 协议面窄（list/status/start/stop/tail），裸 stream + JSON-line 足够，HTTP 的表达力用不上。
代价（手写帧、不能 curl）是**一次性、可控**的，已在 spike 验证。

**这是 owner 决策点**：是否同意 A 命名管道？还是更看重"可 curl 调试 + fetch 最短"选 B？
（m7-phases P3 把 IPC 选型显式标为需 owner 拍板，本 spike 是给 owner 的决策输入。）

> **✅ 2026-06-25 owner 拍板：选 A 命名管道。** 收敛进 [决策 0012](../../.wao/decisions/0012-daemon-ipc-选型-命名管道.md)。
> 本 spike 定格为研究快照；后续以 ADR 0012 为权威。

---

## 对 P3 实现的输入（T0 收敛后，T1+ 的起点）

1. **daemon 机制定了**：detached runner（P2 已有）常驻化 + handshake 文件（pid + 心跳时间戳）
   + IPC（T0b 选型后接上）。无 OS service、无额外 runtime。
2. **daemon 必含自健康**：handshake 心跳超时 = daemon 挂了，CLI 重连时能发现 + 决定重启/接管。
   这是 06-18 孤儿教训的直接投射——不能只"能起"，还得"能知道它还活着"。
3. **IPC 协议面**：`list / status <runId> / start <agent> <prompt> / stop <runId> / tail <runId>`。
   窄协议，无论 A/B 都好实现。
4. **transcript 仍是真相源**：daemon 重启后经 transcript `findState` 无缝接管未完成 run——
   这条 P3 不重新发明，复用现有 `src/transcript.js` 的 `findState`。

## 状态

- ✅ T0a 收敛：detached + unref = Windows 后台存活成立，daemon 无需 OS service。
- ✅ T0b 收敛（2026-06-25 owner 拍板）：**选 A 命名管道**，见 [决策 0012](../../.wao/decisions/0012-daemon-ipc-选型-命名管道.md)。
  P3 daemon IPC = `\\.\pipe\wao-daemon` + JSON-line over `node:net`。
