# 0060：TD-256 批——门禁可见性、TD-252 收口、D3 存量实迁（含三处 0056-0058 期缺陷修复）

- 日期：2026-10-11
- 状态：accepted（Owner /goal 授权：排序立案→opus+sol 会审→实施→真实业务 dogfood→直推收尾）
- 方案会审：consult_20261011142751539zdf6mb（opus 7191 字 + sol 5819 字；三阻断修正 + 两旧缺陷实锤全采纳；关键声称均经 Lead 独立复核后采纳）

## 背景与授权

Owner 2026-10-11 /goal 指令处理四件挂账：①0058 残余 6 棵 verification_failed 陈案收账；②WAO_MCP_REQUIRE_CERTIFIED 可见性钉（前一日考古"不明不白"不安的工程回应）；③TD-252 会话仓卫生三类；④TD-190 D3 存量实迁（此前"另窗 Owner 点名"悬置）。Owner 已重启电脑（含 zcode）——MCP 宿主运行新代码（build 94e0536 实证）。

## 决定内容

### 1. 收账出口（0058 残余闭合）
- 6 棵 verification_failed 陈案（run_20261008{140227412zt6oi1,140233109073jjp,145914710gw7kgm,1653042936d5jcp,1746483140l90u,191953244006n45}，10-08 红队探针交付）decide rejected——1 棵经 MCP `run_delivery_decide`（重启后新代码双通道验证）、5 棵 CLI `runs delivery --reject`。reject 理由文只含可证事实+决定号引用（0052/0054），不带无证断言（sol 必改采纳）。
- **非交付遗留树指定出口**（opus/sol 双阻断采纳）：无 deliveryCommit/baseCommit 的终态非交付线系，lineage-close 仅记账（tip 门必 skipped_head_drift——写 run.lineage_closed 事实），物理释放走证据门控 `git worktree remove`：门=分支名 wao/<runId> 匹配 + porcelain 干净 + HEAD 在案；**分支永不删**（0058 合同延伸）。本批处置 4 棵（2×10-06 glm-flash 旧席位 + 2×0057 会审席）；本批会审席树由 ephemeral 机制自动清。
- 只登记不清：runs/.owner-* 陈旧心跳目录（11 个，08-11～10-05）、runs/.claims 陈旧代际文件（101 个超 CLAIM_STALE_MS）。

### 2. doctor 门禁可见性（TD-256）
- 新检查 `wao_mcp_cert_gate_visibility`（doctor 5e 序）：**恒 INFO**（开与关都是 Owner 合法形态；WARN 会让合法开启常态 DEGRADED、--warn-as-error 常态 exit 1——5c/5d 同纪律）；三作用域（doctor 进程/User/Machine）分报**派生语义**（MCP 判定同款 `=== "1"`，在场≠门开）；值不回显；读取失败≠确认未设置（新 `readWindowsEnvScoped` 三态分作用域读器，User=HKCU/Machine=HKLM 同一 PowerShell 原语）；detail 显式声明"配置面观察，不能代表运行中 MCP 宿主"（宿主 spawn 时定格；**宿主自报=登记缺口**）。
- 顺带修复 5b 死臂：`readWindowsUserEnv` 返回 Promise 被同步 `resolveLoadBearingEnv` 消费=恒 missing（opus 注入实证）；修法=循环前预解析 Map + `config.userEnvReader` 注入缝（与 5d 同款，测试不起 powershell）。

### 3. TD-252 收口
- **①=recycle soak 补 kimi serve 侧归档会话面**（原立案"归档"指 `sessions:archive` 隐藏会话、archived_only=true 可见——0057 W2 实测；非磁盘 runs-archive，本批澄清）：快照两面都拉（任一不可观测→`archived_unobservable` 拒；同 id 合并 busy 取或）。真机 serve 重启后未拉起（Owner 侧），读侧合同锚定 0057 live 探针记录。
- **③=sweep 认领面扩磁盘归档**：`listArchiveTranscriptFiles` 有界枚举（月份目录 /^\d{4}-\d{2}$/、直下 .jsonl 经 listTranscriptFiles、不进子目录、lstat 拒 symlink、字节级预筛 kimi-web、认领冲突上报）；live 位优先于归档位。**真实数据归档臂命中 0**（3063 份归档零 kimi-web 认领，92 条认领全在 live 位）——夹具证明，如实记录。
- **②=限制保留收口**：历史 47 条 kimi-code 转录 session.created 全为 `proc_<pid>` 占位符（无原生会话 id=**无认领键**，opus 扫描实证）、注册表已无该车道（不会再增长）、CLI 无删除原语（`kimi session` 仅 list）、Owner home 文件操作红线——不做自动清理；并入 0056 A4 上游反馈要点。
- 顺带修复：`probeServeSession` 双忙碌字段全缺席时旧实现折叠 busy:false（sol 注入响应实证）→ `shape_unknown` 拒判（unknown≠idle，sweep 误删风险面关闭）；`releaseRecycleLock` 引用未定义 `io`/ESM 无 `require` → ReferenceError 被 catch 吞（"拒绝/完成都释放锁"整段失效，opus 实跑实证）→ 具名 unlinkSync + 回归钉（拒绝后立即重跑不得 lock_held）。

### 4. 0058 占用门死路径修复
lineageClose 占用门原查 `join(runDir,".wao","session-reuse")`——目录不存在（真槽位=`runs/.session-reuse/` 与 `runs/.lineage-reuse/`，条目同款 {runId, updatedAt}），**门从未触发过**（0058 宣称的并发封口实际未生效）。修复后两目录都查；新鲜槽（<SLOT_RECENT_MS=300s）→ `lineage_busy` 拒。

### 5. TD-190 D3 存量实迁（Owner goal 点名）
- `runs migrate-projects --apply`：归宿=写侧权威 `resolveRunDirForWrite`（decide-once/冻结桶/.project.json/索引全复用；计划器保持纯预览面）；在档事实缺 displayName 补 basename(key)（适配层不改写侧合同，sol 阻断采纳）；自洽事实桶≠权威冻结桶→该项拒绝上报。
- 移动原语=同卷 `linkSync`（**EEXIST 原子拒**——Windows rename 走 REPLACE_EXISTING 会静默覆盖，opus）→ dst sha256 核对 → unlink 源；中间态=同 hash 孪生（解析链容忍，崩溃可续跑）；EPERM/EBUSY 单项失败不中止整批。
- manifest=`.wao/migration/td190-d3/apply-<ts>.jsonl`（0045-ledger 同款合法槽）：**intent 行先写**（src/dst/sha256/slug/kind/rulesVersion/unattributed reason）、result 行后写。
- 幂等四态：双在同 hash=删平铺侧（根层才能清到剩非终态）；双在异 hash=twin_conflict 拒；仅 dst=既往 manifest 证明（sha 等已迁/sha 变=追加或损坏仅报告）；双缺=anomaly 告警。
- 门：`--run-dir` 生效（修复原忽略 bug）、拒 worktree 内执行、active run 空、操作员前置条件明示（无并发 decide/reverify/lineage-close/daemon 追加——**并发追加会复活平铺文件**=响亮故障非静默，`--verify` 的"根层再现"点名+手工合并流程在 usage.md）。
- `--verify` 只读核对：dst 在场/sha 漂移/根层剩余/根层再现。
- 回滚边界：仅 manifest sha 是当前内容前缀时可反向；迁移后合法追加不盲搬；新建桶记录不笼统回滚。

## 明确不做（本批）
案 B 十轮计数照常累积（两轮全量各 +1）；TD-209/210 触发型等待；prune --archive 判龄语义不动（"活跃但长期静默 run 被按龄归档"另册观察项）；daemon 自动 serve 维护（0056 明示不做）；分支清退（分支永不删合同）；Owner serve 不由本批重启（workspace 粘滞风险+Owner 基础设施——kimi 车道下次派发时自然拉起）。

## 验收证据（2026-10-11）
- 定向测试：43 项新增/维持（certGateDoctorCheck 7、serveMaintenance 追加 5、kimiServeOps 3、lineageClose 追加 1、runsMigrateProjects 追加 5）+ 守卫合规（backendSwitchCensus 账本 3、transcriptPathGuard 配额 3+枚举合规、hygieneGitState 分支棘轮回 185）——238/238 绿（Node v22.23.1）。
- 全量两轮（迁移前后各一）：314/314 pass / 314/314 pass（canonical，runsGuard clean）。
- 真实业务 dogfood：①真收账（6 reject+10 线系闭合，worktree 11→1，分支 187→185=只删零提交会审席 2 棵）；②doctor 真机输出（门禁关/双作用域未设置/三 warn 均存量）；③D3 真迁移：761 迁移/4 非终态保留/零冲突零失败零再现，--verify 761 dst 全在场零 sha 漂移，claims 91 守恒、总数 843 守恒、根层 765→4，26/26 抽样解析链命中桶内新址，9 桶落成（6 项目+_sandbox/_scratch/_unattributed）。
- 限制如实记录：serve 归档面（①）真机 GET 因 serve 未拉起未执行（合同锚定 0057 live 探针+夹具证明）；sweep 归档臂（③）真实命中 0（夹具证明）。

## 验收会审修正（consult_20261011162041197kru5ln，opus+sol 双席；必改全采纳）
- **active 门死形状修复**（双席同发现）：`authorizedWorkspaceRoot: null` 会使 listRuns 走 fail-closed 返回空集——migrate-projects --apply 与 serve recycle 的 active 门此前恒空（同源旧缺陷在 recycle=0056 期）。修法=省略该键；行为钉+扫源钉（src/ 零处 null 形状）入 runsList.test.js。
- **列表层三形状拒判**（sol#3）：listServeSessions 对缺 has_more/缺 id/双忙碌字段全缺 → shape_unknown（"未知→空闲/完整"折叠全部消除；detail 探针同款纪律补齐列表面）。
- **apply 四态闭环**（sol#2）：根层扫描后对既往台账项逐一补判（仅 dst=already_migrated/anomaly、双缺=anomaly）——四态合同在 apply 自身成立。
- **信封绑定**（sol#4）：sweep 认领（live+归档）与迁移终态推导都绑定文件 runId（legacy 无 runId 兼容；外 run 事件计数可见/不认）。
- **冲突保留**（sol#5）：认领冲突会话永远保留侧（claim_conflict），绝不进删除候选；serve sweep 输出面新增冲突/归档面/信封外事件/读取失败可见行。
- **可观测性**（sol#6）：台账读取失败/坏行计数（manifestUnreadable/badLines——不可观测≠空集）；CLI 退出条件补 factBucketMismatches（明确拒绝≠成功）。
- 登记不阻断：事实桶拒绝发生在 resolver 副作用（可能已建桶）之后（真实数据 0 例）；双 --apply 并发无互斥锁（link EEXIST/unlink ENOENT 响亮失败不静默）。
- **TD-252 状态头修正**（opus V3）：②=限制保留非已修，待 Owner 接受。
- **分支例外明示**：0058"分支永不删"合同的对象是交付线系分支；**只读会审席分支例外**——零独有提交且 tip==main 时可删（本批两轮会审共 4 棵，证据=git log main..branch 空+tips 记录在案）。

## 后果
- 根层 runs/ 只剩 4 份非终态（陈年孤儿，终态后可再跑 --apply 清走）；"平铺=legacy 异常态"语义从此成立（新写全在桶内）。
- 会话仓卫生三死角：两修一登记（②限制保留，Owner 接受或上游修复前不动）。
- doctor 从此常设可见这扇门——"不明不白"的暗门变成体检面。
