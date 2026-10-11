# 0058 — TD-254 线系闭合出口 + TD-253 私有主目录②③④

- 日期：2026-10-11（Owner /goal 指令同法推进；方案会审 consult_20261011085852683tcae2e opus+sol 修正案全采纳；真业务 dogfood 见下）
- 状态：accepted

## TD-254 线系闭合出口（`wao runs lineage-close --run-id X --reason-file F [--apply]`）

Lead 显式放弃一条交付线系。要点（双席修正案）：
- 成员枚举=bound（e.runId===文件 runId）的 session_reuse{rootRunId} ∪ background_submitted{rootRunId} ∪ 根自身；孪生不一致/不可读→拒；根缺席→root_missing。
- 门：全成员终态（unresolved 列出、无 --force）；占用=成员名下槽条目 updatedAt<5min→lineage_busy；验证状态**不设门**（放弃=放弃）。
- 并发封口：close 全程持按根 wx 锁（stale 600s）；continueRun 在 rootRunId 解析后读闭态→拒绝**lineage_closed**（闭集新拒因，wire 重冻 1cf8a4c9）；check→claim 微窗残余显式记录（槽新鲜度门覆盖实际窗口）。
- tip 门（快照纪律）：成员集先冻结；live 分支 wao/<m>∈快照；HEAD=该成员持久事实（**嵌套** delivery.deliveryCommit——dogfood 修正——或 baseCommit）；漂移→head_drift 留树。dirty 不阻塞但记审计（强放弃合同：丢弃未提交字节）。
- 事实=根转录 `run.lineage_closed {rootRunId, reason(≤500), reasonSha256}`（Invariant 1 单一权威；理由正文进事实——sol）。
- **closed≠released**：重入=跳过写事实+补偿重试释放（不复制 W1b already_decided 缺口）。
- 分支永不删；**与 0035 S5"删树删分支"的偏离显式记录**（缩小爆炸半径；S5 由本出口线系形态落地）。dry-run 默认。
- 会话释放不在此出口（范围裁剪）：closed 线系会话由 sweep/A1 族覆盖。

## TD-253 私有主目录②③④（全 live 验证）

- ②设备码登录完成（新家 credentials/ 落地）。**勿复制 credentials/ 双家轮换**（opus）。
- ③试点：注册表副本+`kimi_pilot` 席位（58630/tokenEnv KIMI_WEB_TOKEN_PILOT 进程 env，**不用 setx**）——双席一致方案 D/C。真 run 完成于新家、A1 会话自动删落新家（事件+40401）。
- ④运维闭环：`serve status/recycle --url 58630 --registry <副本> --kimi-home D:\projects\.kimi-worker-kimihome`——实例表读新家、优雅回收 pid 40868→5696、Owner 58627/worker 58628 无恙。
- **接线修复（双席发现的两个现役缺陷）**：serve --url 未命中席位从静默回落改为拒绝；--registry 显式消费。recycle env 硬化：kimiHome 在场显式注入 KIMI_CODE_HOME，缺席**删除**继承值（旧实现 {...process.env} 实际继承操作员 shell——与注释相反）。workspace-dir 三拒（.wao-worktrees 下/kimiHome 内/git 工作树内）。sweep 认领按 serveUrl 分家过滤（防跨家 404 误记 already_gone）。
- 局限在案：分家后 ~/.agents 通用技能仍可见（官方 KIMI_CODE_HOME 只搬 kimi 专属资源）；正式迁移（车道切新家）仍待 Owner 点名——试点通路（注册表副本+进程 env）已验证可行。

## 真业务 dogfood（全部 live）

1. **W1b 首次现场实证**：真 continuable 交付（kimi，文件+验证过）→CLI accept→routing 门终态跳过（A1）→accept 时会话删除（serve 40401）→树内容清空+**分支 d07cd71 存活**→空壳照例被荚占（两段式，recycle 扫壳收尾）。
2. **lineage-close 首次现场**：第二腿真线系→dry-run planned→apply 闭合+释放；**HEAD 漂移门安全挡下一次真缺陷**（嵌套 deliveryCommit 提取缺口——门在错删方向正确失败）→修正后补偿重试（closed≠released 实证）→门全过→空壳（failed_still_present 如实上报）。
3. **③④**如上。

## 残余/移交

- 分支 `wao/<runId>` 永久累积（保留纪律的可接受代价；hygiene 提示已有 waoRunBranches 计数）。
- continueRun 的 lineage_closed 拒因：单测面=REASONS 闭集+插入点；live 拒绝验证留待新 MCP 宿主（当前宿主跑旧代码）。
- 存量 6 棵 verification_failed 陈案：待 decide rejected 后按既有清理脚本收树（Lead 语义决定，随后执行）。
