# transcript 格式

> [使用手册](../usage.md)的一页：transcript 放在哪、记哪些事件、怎么把平铺的旧 transcript 迁进项目桶。

> 事件名与说明的真值源是代码里的登记表 `TRANSCRIPT_EVENT_REGISTRY`（`src/transcriptEvents.js`，冻结闭集——改事件名/说明只改这一处）。本页不维护事件表；完整清单（每个事件一行：何时写、载荷约束、legacy 标记）读生成层 `docs/surface/transcript-events.md`（`npm run gen:surface` 再生成）。写入侧守卫（`src/transcript.js` 的共用事件序列化 + 严格模式）保证代码写出的每种事件都已登记；其它文档（SKILL.md 等）也只指向生成清单，不维护第二份表。

每个 run 的事件流存在该 run 的转录文件里，每行一个 JSON 事件。新 run 写 `runs/projects/<slug>/<runId>.jsonl`；旧平铺 `runs/<runId>.jsonl` 只读兼容，长期共存。定位转录一律经 `src/projectBuckets.js` 的解析链，不要自己拼路径。

`run.message` 不是落盘事件类型：RunManager 把 message 的 role/parts 传给 scorecard 供 `requireAssistantText` 检查，不写进 transcript。

状态机的完整定义见 `docs/02-architecture.md` §4.1，本文不复制状态列表。

交付类 run 的终态语义：

- delivery 打包失败的 run 终态是 `failed`（reason=`delivery_failed`），不是 completed。所以"completed 计数为 0"不等于 worker 什么都没干。
- 反过来 completed 也不保证交付成功：打包成功即转 completed，验证在其后执行且不回改终态；成败要看结果里的 deliveryRef 与 verification 结果。
- 区分"worker 是否产出过模型工作"看 completionMarker：`run.completed` / `run.delivery_failed` / `run.error`(phase=delivery) 可携带 `completionMarker: "completed_empty"`（闭集 DONE_MARKERS 成员），表示 worker 零产出。
- 空 diff 打包失败（`empty_diff`）另有一种相反情形：worker 按交付合同停手并上报了 `SCOPE_EXPANSION_REQUIRED`。此时 `run.delivery_failed` / `run.error`(phase=delivery) 携带 `workerDeclared: "scope_expansion_required"`，`runs diagnose` / `run_diagnose` 的 evidence 多一条 "worker stopped on purpose…" 事实；路径与理由在 worker 的最终回复里（`collect <runId> --final`），失败码仍是 `empty_diff`，不为它新增码值。
- 排查入口：MCP `run_diagnose` / `run_await_result`（CLI 对应 `runs diagnose` / `runs wait`；category=no_effect ↔ code=completed_empty）。交付类 + completed_empty 的失败出口（scorecard 门拦下或打包失败）还会向 `runs/ALERTS.log` 写 level=no_effect 告警，每 run 至多一次。

## 直接读 transcript

```powershell
npm run cli -- tail <runId> --limit 50
# 或直接读文件（路径由 wao 解析链定位，见 docs/02-architecture.md §3）
Get-Content <转录路径> | ForEach-Object { $_ | ConvertFrom-Json }
```

## 存量平铺转录迁移（runs migrate-projects）

把旧平铺 `runs/<runId>.jsonl` 实迁进项目桶。三个形态：

- 默认 dry-run：只读预览桶分布、字节数、无法归因原因分布；`--run-dir` 生效。
- `--apply`：实迁。
- `--verify`：迁移后只读核对。

`--apply` 的行为：

- 归宿判定走写侧权威 `resolveRunDirForWrite`，冻结桶、.project.json、索引全部复用。
- 移动原语是同卷 `link`（EEXIST 原子拒，防 Windows rename 静默覆盖）→ dst sha256 核对 → unlink 源。
- 台账落在 `.wao/migration/td190-d3/apply-<ts>.jsonl`，intent/result 双行，幂等可续跑。
- 门：active run 为空、拒绝在 worktree 内执行、操作员确保无并发 WAO 写操作。
- 非终态转录一律不动（fail-closed）；无法归因的存量迁入 `_unattributed` 桶。

`--verify` 核对 dst 在场、sha 漂移、根层剩余，并点名根层再现——并发追加者持旧路径会在迁移后复活平铺文件；按点名手工合并后再重跑。

回滚边界：没有自动回滚工具。反向移动须人工按 manifest 台账核对，仅当台账 sha 是当前内容前缀时才可反向；迁移后的合法追加不盲搬。

迁移门与回滚边界的由来，为什么见决定 0060。
