# 0012 · daemon IPC 选型：命名管道（`node:net` over `\\.\pipe\wao-daemon`）

> 类别：**决策（Decision）**，ADR，只追加不改写。本 ADR 收敛 M7/P3 的 IPC 选型
> open question（`docs/02-architecture.md:640`），是 T0b spike（`docs/research/13`）后的 owner 决策。
> 2026-06-25 owner 拍板：选 **A 命名管道**。本文定格；若日后推翻，新建 00NN ADR 指向本文。

## 背景

M7/P3（持久 daemon + IPC）有两个 open question，其中 **IPC 选型**（命名管道 vs 本地 HTTP）
被 `docs/m7-phases.md` 显式标为 owner 决策点。两个候选都满足 WAO 硬约束（零 npm 依赖、
Windows 原生、Node ESM），所以取舍是**结构性的**，不是"能不能用"。

## 实测输入（spike，见 `docs/research/13` §T0b）

| 候选 | 可用 | RTT (3 次) | 端口/冲突 | 可远程触达 | 帧格式 |
|------|------|-----------|----------|-----------|--------|
| A. 命名管道（`node:net`） | ✅ | ~1ms | 无（固定管道名） | 否（本机 IPC） | JSON-line over stream（手写） |
| B. 本地 HTTP（`node:http` + `fetch`） | ✅ | ~15ms | 需选端口（冲突/发现） | 是（即便 127.0.0.1 仍是 socket） | 请求/响应（原生） |

RTT 差异对人节奏 CLI 无感，**不是决策因子**。

## 取舍

**选 A 命名管道**，理由排序：

1. **无端口分配 = 少一个状态源。** WAO 已有 run/transcript/worktree 三类状态，IPC 不该再添
   一类端口状态。管道名是确定字符串，CLI 直接连，没有 `portAllocator` 的复杂度蔓延。
2. **不可远程触达 = 安全门面更小。** daemon 是无人值守场景（P3 目标）的持久控制平面，
   pipe 是本机 IPC，不像 HTTP 即便绑 127.0.0.1 仍是 socket（需额外 token 鉴权 + token 状态管理）。
3. **协议面窄，HTTP 表达力用不上。** daemon 协议就几条命令（list / status / start / stop / tail），
   裸 stream + JSON-line 足够。HTTP 的请求/响应/SSE 在这里属过度工程。

**接受的代价（一次性、可控，spike 已验证）**：
- 手写 JSON-line 帧（`\n` 分隔 JSON）—— daemon 协议窄，一次写好。
- 不能 `curl` 调试——提供 `wao daemon ping`（及 `status`）子命令做等价调试入口。

## 否决理由（B 本地 HTTP）

- 必须选端口：要么固定（多实例/占用冲突），要么动态 + 端口发现文件（多一层状态）。
- socket 安全门面更大，无人值守持久进程上风险更高，需补 token 鉴权（又一层状态）。
- HTTP 的成熟协议形态在本场景用不上——选它等于"为了用 fetch 而多扛端口 + 鉴权两层状态"。

## 影响

- **P3 daemon IPC 定为 `\\.\pipe\wao-daemon`（或带实例后缀）+ JSON-line over `node:net`。**
  客户端用 `net.connect(pipe)`，服务端用 `net.createServer().listen(pipe)`。
- daemon 协议（窄面，T1+ 实现）：`list / status <runId> / start <agent> <prompt> / stop <runId> / tail <runId>`。
- **不引入 `portAllocator` 到 daemon IPC**——端口分配仅留给 worktree（原用途）。
- 提供调试入口子命令（`daemon ping` 等）替代 curl。

## 不解决什么

- daemon 的存活/健康机制由 T0a 收敛负责（detached + unref，见 `research/13` §T0a），不是本 ADR。
- daemon 的进程模型/重启策略/孤儿防护属 P3-T1+ 实现细节，本文只定 IPC 选型。
