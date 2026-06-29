# 0013 · 进程隔离 Job Object：复用 Node 内置（v22）vs 自定义实现

> 类别：**决策（Decision）**，ADR，只追加不改写。本 ADR 收敛 TD-40（技术债）的 open question，
> 是行业调研 + 零依赖约束分析后的 owner 决策。2026-06-26 owner 拍板：**选 A 复用 Node 内置 Job Object**。
> 本文定格；若日后 Node v24 回归被官方修复或约束变化，新建 00NN ADR 指向本文。

## 背景

TD-40（外部审计 P2）：架构 spec §4.3 想要"Windows Job Object：父进程终止→子进程全杀"的 OS 级
进程隔离（"进程死即会话死"），但一直未实现，退路是 `taskkill /T /F`。审计指出 Node v24 有
libuv Windows Job Object 回归（杀长进程），所以这件事从"增强"变"安全必需"。

open question：**怎么"实现"Job Object 绑定？** 三个候选——A 复用 Node 内置 / B 自定义 N-API 插件 / C PowerShell 调。

## 实测/调研输入

1. **行业最佳实践 = `taskkill /T /F`**（正是 WAO 现状）。`tree-kill` / `execa` / `execa-tree-kill`
   等主流 npm 包底层全是 `taskkill /T`——**没有主流包直接用 Windows Job Object**（需 native binding）。
2. **关键事实：Node 自 v18+ 经 libuv 已把 spawn 子进程绑进 Job Object**
   （`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）：父进程退出→OS 自动杀全部子进程树。
   v22 上正常工作；v24 是该内置机制回归。所以 v22 上"Job Object 绑定"**已就绪**，无需自定义。
3. **零依赖是硬约束**：`package.json` 无 `dependencies` 键，AGENTS.md 禁 npm install。
   自定义 Job Object 需 N-API/FFI 编译原生模块 → 违反。PowerShell 调（C 方案）零依赖但
   每 spawn 起 powershell 进程有开销、错误处理复杂、难单测。

## 取舍

**选 A：复用 Node 内置 Job Object（v22）+ 保留 taskkill /T/F 主动 abort 路径**，理由排序：

1. **它就是行业最佳实践**。业界标准做法 = 依赖 Node 内置 kill-on-job-close（被动：父死全杀）
   + `taskkill /T/F`（主动 kill）。自定义 Job Object 在业界反而是少数派（内置已够用）。
2. **零依赖不破**。不引入任何原生模块 / 编译工具链 / 平台二进制。WAO 的"零 npm install"承诺守得住。
3. **双重保证互补，非二选一**。(a) 内置 Job Object = OS 级被动（父进程崩溃/被杀也兜底）；
   (b) taskkill /T/F = 主动 abort（run 终态时确定性清理）。两者覆盖不同失败模式。
4. **v24 回归用 engines + 启动校验兜**。`engines.node: ">=22 <25"` + `src/nodeVersionGuard.js`
   在 cli/daemon/backgroundRunner 入口拒绝 v24，等官方修复版后把已修复版本移入放行清单（数据驱动）。

## 决策

- **不实现**自定义 Job Object（B/C 方案）。
- **守**：`engines.node: ">=22 <25"`；`nodeVersionGuard.js`（v22 放行 / v24 全拒 / 未来修复版可注入放行）
  接入 cli + daemon + backgroundRunner 三个 spawn 入口。
- **保留** `taskkill /pid /T /F` 作主动 abort 路径（行业最佳实践）。
- **重定义** TD-40：从"实现 Job Object 绑定"→"在零依赖约束下，靠 engines+启动校验守住 v22 的 OS 级
  进程隔离（复用内置 Job Object）"。TD-40 标 ✅ 偿还。

## 后果

- **正向**：进程死即会话死从 taskkill 兜底升级为 OS 级保证（v22 上）；零依赖不破；维护点收敛为一个
  数据驱动的版本清单（官方发 v24 修复版时维护 `ALLOWED_FIXED_VERSIONS`）。
- **约束**：**生产必须用 v22**（v24 被拒）。开发测试用 `WAO_SKIP_VERSION_GUARD=1`（`npm test` 已注入）
  在任意 Node 上跑（测试 mock 真实 spawn，不依赖真实进程隔离）。
- **未来触发**：Node 官方发布 v24 Job Object 回归修复版 → 把已修复版本加进 `ALLOWED_FIXED_VERSIONS`
  + 放宽 engines；或若内置机制日后又回归其它版本，更新 `nodeVersionGuard.js` 黑名单。
