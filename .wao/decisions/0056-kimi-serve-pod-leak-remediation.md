# 0056 — TD-250 kimi serve 进程荚泄漏：终态会话卫生 + 手动 serve 维护族

- 日期：2026-10-10（批准：Owner 指令"接下来处理这个问题"，点名 TD-250；方案会审 consult_20261010220638436s4gchx kimi+opus 双席"方案可立"+修正案全量采纳）
- 状态：accepted

## 背景（全部本机 live 实测，2026-10-10 晚，kimi 2.1.1）

TD-250 立案的"MCP 实例泄漏"（Owner 资源管理器实地观察）根因解剖：

- **F1 泄漏形状**：kimi serve 为**每个会话**在创建时（零 prompt 的空会话也会）拉起一荚进程：kimi-datasource 插件（kimi.exe）、cmd.exe、mcp-server-analyzer、officecli、+ ~/.kimi-code/mcp.json 注册的每个 MCP（本机含 wao 对：wao-node.cjs + stdio.js）。约 6-8 进程/会话。
- **F2 无拆除**：无空闲 GC（4-9 小时旧荚全活）；会话 `:delete`、工作区 `DELETE` 后荚均存活（两独立样本 5 分钟+）；无任何停荚端点（web UI 前端 bundle 全量路由普查 v1+v2）。**唯一全量拆除原语 = 优雅 `POST /api/v1/shutdown`**：serve+荚+实例元数据全清、零孤儿（实测）。
- **F3 会话生命周期 API**：`POST /api/v1/sessions/{id}:delete` 有效（连带删 serve events 文件；已亡=HTTP 200+code 40401）；`DELETE /api/v1/workspaces/{id}` 有效；v2 仅 `sessions:archive/:restore`。
- **F4 存储共享**：会话/工作区仓跨 serve 实例共享（58627 Owner 主用/58628 WAO worker 专用同仓）；serve 重启不丢会话（重启后旧会话照常列出、transcript 内容可读、不回荚）。
- **F5 无按实例配置面**：serve 无 mcp.json 覆盖 flag（worker serve 无法单独不装 wao MCP）。
- **重启实证**：端口 ~2s 重绑、bearer token 不变（仓级稳定）。

## 决定

**A1 终态会话卫生（backend 能力位，自动）**：声明 `supportsSessionRelease` 的 backend（首个=kimi-web）在 run 终态清理路径（`_runCleanup`，停止验证之后、cleanup 段之前，幂等单发）best-effort 调 `releaseSession(agent, sessionId)` → `POST :delete`。门：
1. routing 门——sessionReuse routing 在场（lead_workspace 复用轮/continuable 线系根/resume 轮）跳过（线系可能续接；与 provider-session 绑定事实写侧同源谓词）。
2. completed-only——`this.state==="completed"`（转录仲裁已接受态）才删；failed/aborted 会话保留（上游轮可能仍在跑或已跑完未收，serve events 文件=迟到收取 SOP 取证源；Owner 亲自纠正过：久等≠失败）。第三门（aborted+idle 探针即删）双席一致否决。
3. busy 预探针在 backend 内部（detail 双严格 false 才放行；纠偏排队-未 steer 不对称）。

事件族**一果一名**（投影图 type→label 盲载荷——outcome 字段上不了面）：`run.upstream_session_deleted` / `_already_gone` / `_delete_skipped{reason: routing|not_completed|busy}` / `_delete_failed{reason[,code]}`。恰好一条（能力在场且有 backendSessionId 的 run；pre-spawn 终态零事件）。backendSessionId=审计锚；载荷绝无 token/上游回显。崩溃窗口（删完事件未落盘）接受零条——清扫器遇 40401 记 already_gone 闭环。

**A1b 验收释放（decide 侧）**：`run.delivery_accepted` 落盘后（线系不可变持久事实，parent_accepted 拒续）best-effort 释放线系会话（`makeAcceptedSessionRelease`，MCP 与 CLI 两装配点注入）。rejected 永不触发；释放失败吞错绝不影响验收结果。关掉"continuable 线系会话+保留 worktree 无限滞留"类。

**A2 手动 serve 维护族（`wao serve status|sweep|recycle`；不挂 daemon、无自动触发——双席一致，理由=worker serve 全机共享的归属权含糊+自动重启 env 组装事故会静默失效 0047 env 臂防线）**：
- `serve status`：实例元数据/荚规模/会话计数（零副作用）。
- `serve recycle`：门=WAO 全项目桶 active-only（心跳新鲜；unresolved 不堵——runner 死 run 不永堵回收）+ serve 会话集合 soak（快照→等 12s→复探集合**逐 id 相同**且全 !busy——busy-only 复探有 createSession→sendPrompt 间新会话 idle 的洞，集合比对把窗口压到构造上不可命中）→ 优雅 shutdown（端口/进程死亡证实，超时回退 taskkill /T /F）→ 重启（**env 组装权归命令**：WAO_IN_WORKER=1 恒注入、--workspace-dir 显式必填无隐藏默认、detached）→ 就绪轮询 ≤30s → 后验证（新 pid/荚计数）。recycle-vs-recycle 互斥=wx 锁 600s 陈旧回收；**只防回收互撞不声称防新派发**（残余=秒级窗口内新派发显式红）。
- `serve sweep`：**按会话认领**（WAO 转录 `session.created.backendSessionId`，扫全部项目桶——不按 wd_* 命名启发式）+ "worktree 已亡"门三条件（形状=父目录名 .wao-worktrees 大小写折叠；干净 ENOENT；父目录在场可读否则 suspect 整批放弃）。默认 dry-run，`--apply` 才删；台账=独立 JSONL（`.wao/serve-maintenance/sweep-ledger.jsonl`，不写 run 转录——ADR 0034 归档/哈希纪律不触碰）。**跨 serve 生效**（F4 共享仓）——命令输出明示。

**A4 上游反馈**：kimi 2.1.1 serve 不拆助手进程=上游缺陷；建议 Owner 反馈 Moonshot，点名要"idle 荚 GC 或 :delete 连带拆荚"——上游修复后 A2 recycle 退役（A1/A1b 保留：会话仓卫生独立有价值）。

## 明示不做 / 边界

- kimi 自家荚成员（datasource/analyzer/officecli）与 Owner serve（58627）名下存量荚不在 WAO 自动处置范围——Owner 自行重启 58627 解决；A2 只动 lane serveUrl 指向的 worker 实例。
- failed 会话的清扫无第二判据（kimi 席提出的"终态≥N 天+空闲"Lead 显式触发版）——本轮不做，存量 failed 靠人工/后续裁定。
- worker serve 私有 kimi 主目录（USERPROFILE 重定向实测可行：独立 mcp.json/不混 Owner 会话列表）——代价=单独登录，留 Owner 裁定，本轮不入。
- 事件族不进 MCP 输出面（信封标签投影）；run_activity 的 envelope enum 随 ENVELOPE_TYPE_TO_LABEL 增四值（additive，wire 帽内）。

## 验收

- 单测：kimiWeb releaseSession 七钉（闭集结果/一枪不重试/无 msg 回显/参数门）+ runManager 集成八钉（门 1/2/映射/幂等/次序/吞错/pre-spawn 零事件/全流程）+ A1b 六钉 + serveMaintenance 十钉（门纯函数/soak/锁/规划/台账/recycle 拒绝闭集+成功路径 env 断言）。
- 真机 dogfood：见 docs/usage.md TD-250 节（新增会话自动删实证 + recycle 实拆实证）。
