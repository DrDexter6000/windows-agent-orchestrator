# 0057 — TD-251 worktree 生命周期根修 + 会话仓存量卫生 + 私有主目录阶梯①

- 日期：2026-10-11（Owner /goal 指令：排序立案→草案→opus+sol 会审→推进→真业务 dogfood→推送）
- 会审：方案 consult_202610110709306023ro7zi（opus+sol，修正案全采纳）；真业务验收 consult_20261011075628090y3wetn（kimi 单席评审 0057 草稿，三跨条款发现+四绕过路径逐条裁定）
- 状态：accepted

## W1 worktree 生命周期根修（TD-251 前向修法，落地）

**W1a readOnly→ephemeral（双门+延迟释放）**：`readOnly && !sessionReuse` 的强制隔离改
`{worktree, ephemeral}`。作用域谓词钉死（席位 F0-1）：只限 readOnly 强制路径——
delivery 不受影响（readOnly⊥delivery 互斥是救场，显式入合同）；显式 `isolate:true`
与 agent 配置 isolation（含其 ephemeral 变体）行为**零变化**（后者维持既有无停止门
的直接删除，系 0057 之前既有合同）。删除不在 start 组装 cleanupFn，改为 Run 的
`deferredWorktreeRelease` 在 `_runCleanup` 里、停止验证**之后**处置：
- 停止确认 = `_verifyStopQuietIfCapable` 写 `run.stop_verified` 的路径置 `_stopQuietConfirmed`
  （probe-quiet 但事件写盘失败 = **不确认**——fail-closed，席位附评）；未确认 → 留树 +
  `run.worktree_release_skipped{reason:"stop_unconfirmed"}`（迟到收取窗口；周期普查兜底）。
- **stop 门只罩 worktree 删除段**：`composeBackendDispose`（含 claude-code OAuth 凭据
  副本回收）无条件执行（席位 F0-2——安全回收绝不被树保留连带跳过）。

**W1b 验收放树（四道门，挂在 makeAcceptedSessionRelease Part B，与 Part A 会话释放
两段独立 try）**：
1. **tip 门**：live git 读（`git -C <path> rev-parse`，经 `gitChildEnv()` 禁 replace
   objects——TD-236 纪律）分支 === `wao/<runId>` 且 HEAD === deliveryCommit（右侧=转录
   持久事实）；子轮接管→`not_tip` 跳过。**左侧恒 live 读**（席位 Q2-1 最危险歧义：两侧
   都读转录会空转通过并删子轮正用的树——实现与合同双钉）。
2. **路径证明**：目标=本 run 绑定的 `run.started.worktreePath`（子轮记录被收编的父路径
   ——席位 Q2-3；不按名推导）+ lstat 非符号链接/junction（mklink /J 实测钉：
   Node lstat 报 isSymbolicLink）+ 父目录段名 `.wao-worktrees`（大小写折叠）。**声明**：
   段名检查不锚 realpath（本仓安装即 junction，0049——realpath 锚会全军覆没）；信任边界
   = run.started 是控制面写的事实、非 worker 可注入。
3. **独立释放**：Part B 不被 Part A 任何提前返回挡住。
4. **事后验证**：`removeWorktree` 恒 resolve 自吞错——成功判定 = existsSync 为假；
   抛错路径统一 existsSync 复检收口（席位附评：抛错≠完好，可能已半删）。
   `still_present` 语义 = **可能已残缺**（真 dogfood 实证半删形态），普查按可疑处理。
分支 `wao/<runId>` 永不删除（accepted commit 可达性；测试钉）。dirty 工作树不阻塞放行
（验证 artifact 常态，明写）。TOCTOU（门读→删除窗 vs 续接转换，双 MCP 实例跨 Lead 并存
时）= 接受的残余，普查兜底。

**W1c 回收后空壳清扫（dogfood 发现的闭环）**：真实会审席位树在终态清理时内容+git
元数据全删，但**空目录壳**被泄漏荚的工具壳（cmd.exe 以会话 worktree 为 cwd）占住
句柄（Windows EPERM，荚不死句柄不释）→ `recycle` 杀荚后补扫：`sweepEmptyWorktreeHusks`
只删 `run_` 前缀+**完全为空**的目录（真 worktree 恒有文件；recycle 双门已保证无活跃
run）。dogfood 实证：`emptyWorktreeHusksSwept:1`、壳清、树数复原。

**事件族**（一果一名，与 upstream_session_* 同构）：`run.worktree_released` /
`_already_gone` / `_release_skipped{reason: stop_unconfirmed|not_tip|unproven_path}` /
`_release_failed{reason: still_present}`。两个发射点（W1a=Run 清理路径、W1b=decide 钩子）
各自恰好一条、幂等；载荷不带路径（审计锚=绑定 `run.started` 的绝对路径——与席位
"带 worktreePath"建议相反的取舍：避免转录内重复，路径已是绑定事实）。信封标签
+4 投影/ dashboard / td220 钉；wire 重冻 379e8f0b→e5b46588（enum additive，帽内）。
事件不进架构 §3.2 / usage §三事件表（A1b 先例，避开字节帽）。

**明示不做**：rejected/undecided 线系的树无自动回收（判定"已放弃"=语义判断=Lead 主权，
按龄/按量自动淘汰否决——席位 Q3）；"死后代"类（父 accepted+子 undecided 持分支 → tip
门正确挡下 → 再无 decision 触碰）与死在线系里的 rejected/undecided 一起归口 TD-254
（方向=补"线系闭合"持久事实出口，镜像 A1b 触发形态，Lead 显式动作）。

## W2 会话仓存量卫生（已执行）

- `serve sweep --apply`：28 删（认领+树亡+completed+idle；apply 逐项复探——sol 修正：
  探针补 `main_turn_active`、缺字段不再折成 false）。
- 批量归档 22（v2 `sessions:archive`，逐项结果核对零失败；台账
  `.wao/serve-maintenance/archive-ledger.jsonl`）。归档门：worktree 形状+root 干净
  ENOENT+completed+idle+**runId 转录归属证明**（防 Owner 手开会话误伤——实测 1 条
  无转录会话列出不动）。单会话探针全过：默认列表隐藏、`archived_only=true` 可见、
  **归档态转录仍可读**（取证面不受影响）、restore 往返。Owner 列表 533→483（28 删
  +22 归档）。残余：recycle 枚举不含归档项（sol 警告）→ 只归档 completed+idle，
  完整关闭留 TD-252。
- suspect×2（嵌套双层 worktree 父链已亡）按 fail-closed 保留。

## W3 私有 kimi 主目录阶梯①（已执行，②③④ Owner-gated）

`KIMI_CODE_HOME`（官方变量，serve 遵守实证）备端口 58629 探针八项判据全过：端口
预检+127.0.0.1 绑定+实例 json/token 落新家（平铺布局=KIMI_CODE_HOME 即家本体）、
Owner 家实例注册表与会话集合（483）前后不变、token 矩阵（新 token 过/Owner token
40101/无 token 40101）、空会话+events 文件+索引全落新家、优雅退出零遗留（端口/pid/
实例元数据）。**重大发现**：新家建空会话**零子进程**（Owner 家同操作立即拉 6 进程
荚）——待②登录后真实轮次复验；若成立，分家后 worker 侧泄漏近乎消失。②设备码登录
（需 Owner 浏览器）③最小试点④运维闭环（前置=WAO 侧 readServeInstances/recycle env
接线改造，opus E1/sol 同发现）= TD-253 待 Owner 排期。①通过只证数据家分离；
`~/.agents` 通用技能仍可见（官方文档），Invariant 2 只部分收窄。

## 新立案（随本决定登记）

- **TD-252** 会话仓卫生残留：recycle 归档盲区完整关闭、kimi-code CLI 车道终态清理
  缺失、runs-archive 会话认领面扩展。
- **TD-253** 私有主目录②③④（Owner-gated）+ WAO 维护面接线改造（readServeInstances
  kimiHome 参数化、recycle env 显式组装 KIMI_CODE_HOME/USERPROFILE）。
- **TD-254** 线系闭合出口（"死后代"+死线系 rejected/undecided 树的 Lead 显式关闭
  动作；含存量 8 棵的处置路径）。
- （opus 附带发现，随 TD-252 一并记录）readOnly×lead_workspace 读写错位（复用第二轮
  写旧树 A、观察权威在新树 B）与崩溃恢复 resume 的源仓 cwd/不删树两缺口——隔离边界
  的崩溃恢复族问题。

## 验收

单测 33/33（W1 四文件）+守卫套件全绿（wire 重冻/字节帽 133833≤133845/投影/dashboard）；
真业务 dogfood：单席会审（真评审 0057 草稿、24 工具调用、零写入）→ stop_verified→
树内容+git 元数据即删→`_release_failed{still_present}`（壳被荚占——诚实上报）→
recycle 扫壳闭环 `emptyWorktreeHusksSwept:1`。全量 canonical 见提交信息。

## 修订（2026-10-11，决定 0062 丙′——分支回收）

W1a 的"此处不做分支清理"（opus Q2-7 accepted commit 可达性理由）收窄为**"有独有提交
才保留"**：ephemeral 只读 run 的 worktree 释放成功后，`wao/<runId>` 分支零独有提交
（`git rev-list --count <branch> ^<其余全部本地 refs>` === 0，`git branch -d` 拒绝即
保留）则回收，有独有提交则保留+记事件 `run.worktree_branch_kept{uniqueCommits}`。
一致性链：0058"分支永不删"的合同对象始终是**交付线系分支**（0060 已明文）；只读/
非交付零独有分支例外在 0060 由 Owner 追认；本修订把该例外机制化到自然释放点
（_releaseDeferredWorktree——stop 确认门+删后 existsSync 复检+事件四件套已在场，
第四道门=零独有判定在 isolation.recycleRunBranch）。运行期形态零变化（vs 甲案
--detach：分支照建、worker 无感知、无新行为面——kimi 席从 worker 体验确认
detached 无可感知差异，但丙′ 保留违规提交证据的纵深更优）。rejected/undecided
交付分支仍永不删（语义判断归 Lead，席位 Q3 否决按龄淘汰不变）。

### 修订补记（同日，0062 审核轮——判据差异与文案修正）

- **判据差异明示（opus/sol 审核条款）**：上方修订的运行期判据（零独有=被**其余全部
  本地分支与本地 tag** 覆盖，`--not --exclude=<self> --branches/--tags`）是 0060 例外
  证据形（tip==main）的**放宽**，不是同一证据形：被任何其他本地 ref 覆盖的零独有
  分支亦可回收；仅由 tag/remote 保住的提交会被保守计为独有（remote-tracking 不在
  排除集）。提交零丢失性质不变。存量手工清理脚本（.dev）用的是"包含于 main"判据
  ——三套判据并存以本节为现行运行期权威。
- **覆盖面修正（opus 实锤）**：kimi-web 车道只读轮常止于 `release_failed{still_present}`
  （荚占句柄壳）而非 released——回收挂在 released/already_gone 两臂（停止确认后），
  still_present 臂不回收（分支多半仍被该 worktree 检出，-d 自拒），留待荚清扫+普查
  （TD-262）。spawn 失败轮此前整棵泄漏（Run 未构造、deferredWorktreeRelease 无人
  认领）——已在 0062 审核轮修复（spawn catch 补树清理+回收）。

## 修订

- 2026-10-15：上文"分支 `wao/<runId>` 永不删除"与修订节"rejected/undecided 交付分支仍永不删"改为"除按决定 0082 经 Owner 批准的清退外不删"；本决定其余部分不变。
