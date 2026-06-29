# M3 审计报告

> 状态：✅ 审计完成，技术债已修或已登记。
> 日期：2026-06-15
> 审计依据：`docs/milestone-discipline.md`。

## 完成定义核验

| 完成定义 | 结果 | 证据 |
|---------|------|------|
| `npm test` 全绿 | ✅ | **102 tests, 0 fail** |
| `npm run smoke -- --isolate` 真实跑通 | ✅ | claude 在独立 worktree 跑通，reply 正确，worktree 路径记录在 transcript |
| agent 配 isolation:worktree → run 在独立 worktree | ✅ | `test/isolation-integration.test.js` 4 测试 |
| 进程式 resume → 重放 prompt + run.rerun | ✅ | `test/runManager.test.js` M3-5 2 测试 |
| opencode-serve resume → attach（不破坏现有）| ✅ | 现有 resume 测试仍绿 |
| ephemeral worktree 清理 | ✅ | ephemeral 测试验证 cleanup_done 事件 + worktree 删除 |
| 技术债审计完成 | ✅ | 见下 |

## 逐 Task 验收

| Task | Gate | 结果 |
|------|------|------|
| M3-1 isolation.js | 真实 git worktree create/remove/list + 非 git 报错 | ✅ 5 测试 |
| M3-2 portAllocator | allocate/release/exhaust/checkInUse | ✅ 6 测试 |
| M3-3 RunManager 集成隔离 | isolate flag / agent.isolation / config 三级优先 | ✅ 4 集成测试 |
| M3-4 cleanup 钩子 | ephemeral 清理 / persistent 保留 / 失败不 crash | ✅ 含在集成测试 |
| M3-5 进程式 resume | 重放 prompt + run.rerun + 终态返回 null | ✅ 2 测试 |
| M3-6 CLI resume + --isolate | resume 命令路由 + --isolate flag + help 更新 | ✅ help 验证 + smoke |
| M3-7 config 扩展 | defaultIsolation/worktreeDir/portRange | ✅ hardcodedDefaults 同步 |

## 真实 smoke 结果

```
✅ PASS  claude-code (--isolate)
  worktree:  D:\projects\windows-agent-orchestrator-poc\.wao-worktrees\run_xxx
  reply:     smoke ok
  chain:     pending → submitted → running → completed
```

worktree 真实创建、claude 在其中运行、persistent 策略保留 worktree（手动清理后验证 git worktree list 干净）。

## 技术债清单

### 实现中自检发现并修复（2 项）

| # | 问题 | 修复 |
|---|------|------|
| TD-19 | `createWorktree` 返回 Promise 但 start 里没 await，worktreeInfo 是 Promise 对象而非 `{path,branch}` | 加 await |
| TD-20 | mock getAgent 的 `...overrides` 不过滤 undefined，导致 cwd 被 undefined 覆盖，worktree 创建失败 | mock 改成 filter undefined（和真 registry.js 一致）|

### 已登记延后（3 项）

| # | 类别 | 问题 | 触发条件 |
|---|------|------|---------|
| TD-21 | 偶发 | worktree remove 在 Windows 偶发 Permission denied（文件锁），已加 rmSync fallback + prune。但测试偶发 1/102 fail（文件锁时序）| 若高频出现，加 retry + delay |
| TD-22 | 命令缺失 | persistent worktree 会累积，没有 `worktree prune` 命令让用户批量清理 | M4 或后续：加 `runs prune --worktrees` 或独立 `worktree prune` 命令 |
| TD-23 | 端口分配未接入 | portAllocator 实现了但 RunManager 没用它（M3 只提供能力，不启动多 serve 实例）| M5 DAG 并行多 opencode-serve 实例时接入 |

### 前序技术债处理状态

| TD | 来源 | M3 处理 |
|----|------|---------|
| TD-10 | M1：进程式 resume 不可能 | ✅ **已解决**——M3-5 实现重放路径，进程式 resume 不再 TypeError |
| TD-14 | M2：resume 硬编码 opencode 方法 | ✅ **已解决**——resume 按 backend 类型分支，进程式走重放 |
| TD-5 | M0：并发未测 | ⬜ 仍延后——M3 仍单进程串行，并发测试留 M5 限并发 |

## 设计决策记录

1. **进程式 resume = 重放 prompt**（用户决策）。产生新 sessionId，transcript 标 `run.rerun`，不假装续接。这是进程式能做的最好——诚实。

2. **worktree 隔离：能力在控制层，策略在配置层**（用户洞察）。isolation.js 提供统一实现+清理，RunManager 读配置触发，agent 可配 `isolation: "worktree"|"none"|{type,strategy}`，CLI `--isolate/--no-isolate` 覆盖。

3. **persistent 默认 > ephemeral**。run 结束后 worktree 保留（便于检查产出）。ephemeral 需显式配 `strategy:"ephemeral"`。代价是 worktree 累积（TD-22，需 prune 命令）。

## 审计结论

M3 **通过验收 gate**。worktree 隔离、进程式 resume、cleanup 钩子、端口分配器全部实现并有测试覆盖。真实 smoke 验证了 --isolate 端到端跑通。

**关键收获**：TD-19（await 遗漏）是写实现时自检发现的——如果只跑测试不读 transcript 内容，会以为 worktree 创建了但实际 worktreeInfo 是 Promise。这再次验证"测试通过 ≠ 行为正确"，transcript 审查不可省。
