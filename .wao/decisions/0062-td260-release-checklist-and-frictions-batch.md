# 0062: TD-260 批——发版检查单 + frictions 三方会审收口

status: accepted
date: 2026-10-11

## Context

Owner /goal 两指令：①应有一份"发版检查单"，且**严守 SSOT 法条**——确保 SSOT 文档间无
不必要的重复内容、必要的相互指针引用在位（Owner 明示担忧"只增量不去重"）；②把
"值得排期的在册 TD + Lead 亲历未立案摩擦"的原文清单、推荐优先级、处置方案交
opus/sol/kimi 三方头脑风暴，Lead 汇总成执行方案一次推进完成，关键交付物请 opus/sol
审核，除严重 red flag/架构冲突外不停下请示，最终交付前真实业务 dogfood。

三方会审：consult_20261011214726612w5jiem（opus 7333 字 / sol 5146 字；kimi 席
channel failed=serve 死亡），kimi 腿以只读直接派发重试（run_202610112158277247ygq3n，
190 事件，预算窗后迟到收取——Owner 2026-10-10 反馈"久等≠失败，必须补收迟到结果"
的执行）。Lead 对 opus 三条改变方案的事实全部亲手复核属实：TD-249 代码 c3047e2 已随
v0.4.0 修复仅剩台账/头注漂移；v0.4.0 changelog "周期内无 completion 判定改动"陈述
不实（77efe1b/ccdaadd 实证）；v0.3.0/v0.3.1 为轻量 tag（cat-file 实证）。

## Decision

1. **发版检查单 = milestone-discipline §9**（三席一致）。0038 保留策略与理由；检查单
   只做操作入口（有序八步+证据落点+指针零复制）；§8 第一条缩为指回 §9 的指针（同文件
   防"只增不去重"的第一例——opus 条款）；§6.7 "三 provider 全绿"改为指向
   certification.matrix 当前装配（sol 发现的陈旧表述）；reliability 门槛**无条件**、
   唯一开口=Owner 逐次具名豁免+changelog 登记（kimi 条款，防 v0.3.0/v0.4.0 式空跑
   再发生又不悄悄开口子）；每步留证据记录（kimi 条款）。v0.4.0 changelog 追加勘误节
   （不实陈述+轻量 tag 登记，不重打——重打改变已发布 tag 对象）。
2. **B7 只读分支顶棘轮 = 丙′**（opus/kimi 支持，sol 支持甲收窄版；Lead 综合取丙′：
   运行期形态零变化、违规提交证据保留纵深、0060 例外机制化到自然释放点）。机制见
   0057 修订节（含审核轮补记：判据系 0060 证据形的**放宽**、三套判据以运行期为现行）；
   乙案（计数排除零独有）三席一致否决（计数对状态说谎）。甲案（--detach）留档未
   采纳：sol 红队的 lineageClose/upstreamSessionRelease tip 门在 detached 下永挂
   skipped_not_tip、resume() 崩溃恢复未恢复只读放树参数、detached 上违规提交随树删
   蒸发——kimi 确认 worker 无感知差异但丙′ 覆盖面更优。存量批量清理 157 删
   （190→33；判据=转录 run.read_only_declared+rev-list main..branch===0+`branch -d`
   自证合并；逐支清单见本档"存量清理证据"节；2 条 `-d` refused 留树=spawn_error
   泄漏形状[审核轮发现并已修复代码]，树由 Lead 手工清）。**棘轮帽 185→60（审核轮
   改判）**：初判"不下调"被 opus 否决（回收机制仍有 kimi still_present/resume 泄漏
   路径在册，宽帽让棘轮在泄漏复发时失去报警作用）+sol 附议"帽值取舍要明示"——
   下调至 60 保留报警灵敏度，变更记录=代码注释+双只降钉+本档（只降方向，0042 允许）。
   **spawn_error 泄漏修复（审核轮新增，opus 实锤）**：readOnly 轮 spawn 失败时 Run
   未构造、deferredWorktreeRelease 无人认领——树+分支永久泄漏；已在 spawn catch
   补树清理+零独有分支回收（与 _releaseDeferredWorktree 同款事件）；回收触发臂=
   released/already_gone（停止确认后；append 成功为准——sol 条款），still_present
   臂不回收（分支多半被检出，-d 自拒；留待荚清扫+普查=TD-262）。
3. **B8 命名空间 = 反向 Unknown 指路 + 记法统一**（opus/kimi 支持，sol 支持别名案；
   Lead 取反向提示：与 TD-191④ 对称、零入口闭集膨胀、治根因"wao X 一词两义"）。
   顺带修 COMMAND_NAMES 缺 serve 漏员（TD-250 加 HELP_TEXT 行时漏成员、单向守卫
   失明——A-1 守卫改双向，与 TD-257 backend 计数派生守卫同型教训）+usage.md 同页
   两记法修正+记法约定行。
4. **B9 = 乙′+丙**：drift 闭集扩 seatRole（0024 修订节）+doctor 指针行（同一比较器，
   opus 条款——否决 doctor 独立比对的第二权威方案）+私有副本 7 席按模板值补齐
   （备份先行；sol/kimi 定界"显式 non_seat 是合法语义、确认权在 Owner"——本批 Owner
   /goal"一次推进"授权内执行，备份可回退，终报呈请过目）。已知限界（kimi）：人读面
   未区分"缺席 vs 不匹配"（JSON 面已区分）。
5. **B10①**：needs-selection 人读面明示正常出口（outcome 枚举/exit 0 不动）+调用形
   改规范记法。**B10②** 不动（AGENT_ONBOARDING:64 已有 --silent 规程）。
6. **登记未实施**（留档待 Owner 点名）：B2②（TD-174 行红队补记入册）、B3（TD-172 行
   红队补记）、TD-261（serve recycle 死实例复活缺口+kimi 的 supersedes lineage
   候选）、W4 红污染无关 worker 交付收条（kimi 提议——登记册拒洗白的代价面，裁判权
   Lead/Owner）、会审 brief 逐声称附锚点（kimi 提议，Lead 实践吸收不再立项）。

## Consequences

- 会审/只读轮分支**正常路径**不再累积（丙′ 自动回收；限 released/already_gone 臂）。
  已知不回收残留路径登记 TD-262：kimi 车道 still_present 壳（荚占句柄）+ resume()
  不恢复 deferredWorktreeRelease——残留靠荚清扫/普查兜底，棘轮帽 60 保持报警。
- run_activity envelope enum +2（worktree_branch_recycled/kept），wire SHA 重冻
  b54c4212（additive，帽内复验通过——0056/0057 同流程第三例）。
- 发版流程从此有单一操作入口（§9，审核轮重排序：版本面手改与快照准备前置于全量、
  1.0.0 门槛判定前置于打 tag、最终候选提交=tag 指向已验证工件、先推 main 再推 tag）；
  v0.4.0 的历史不实陈述以追加节修正，不改写（勘误自身的 ccdaadd 误引在提交前修正）。
- ADR 0034 第 4 条的分支删除半边补修订节（被 0057/0058/0060/0062 取代——审核轮
  opus 发现的现行 ADR 冲突）。
- 私有 registry 席位语义恢复（seatRole 显式声明；astra/opus=adversarial、
  sol=implementation 等按模板值）；后续模板 seatRole 改版会经 onboarding/doctor
  drift 面直接可见。

## 审核轮（2026-10-11 深夜，consult_202610112242214659ox62x opus+sol）

五个交付物全 PASS-with-fixes/D2 初判 FAIL，必改项全采纳并全部落实：D1=released 事实
以 append 成功为准（sol）/already_gone 臂开放回收+still_present 不回收（opus）/
absent≠探测失败+计数拒空输出（sol）/正向 revision 全名防同名 tag 遮蔽+refs 帽废除
（改 --exclude 形，opus）/spawn_error 泄漏修复（opus 实锤）/存量清理证据清单落
tracked 记录（双席）/帽 185→60（opus）；D2=§9 顺序重排（README 手改前置——sol
FAIL 项）/§8.1 具名 troubleshooting.md/豁免三态与 PATCH 落点/先推 main（双席）/
ADR 0034 修订（opus）；D3=守卫 `^  (\S+)` 捕全词+缩进形状钉（sol）/wao 排除出反向
提示（opus）；D4=模板声明才可比（opus）/兜底措辞条件化（sol）；D5=ccdaadd 误引
修正（双席）/"净"字/归因句去淡化（opus）/TD-260 行措辞修正。漏网边界登记 TD-262。

## 存量清理证据（157 支，2026-10-11）

- **判据（逐支验证）**：转录含 `run.read_only_declared` + `git rev-list --count main..b === 0`
  + 删除经 `git branch -d`（git 自证已合并才删——逐支最强事后证明）。脚本
  `.dev/td260-branch-cleanup.mjs`（gitignored；只读识别用子串匹配，实跑 465 命中
  误报 0——opus 实测；复用时改 JSON 解析）。
- **计数**：dry-run 159 条 deletable → apply 删 157、`-d` refused 2
  （`run_20261011214727509zvomg4`/`run_20261011215249230uc4u3z`——spawn_error 形，
  审核轮确认根因并修复代码；树由 Lead 手工清）。
- **逐支清单的诚实声明**：apply 输出的逐支 `DELETED` 行在采集时被 `grep -v` 过滤
  （Lead 过程失误，如实记录）；分支删除不留 reflog，**今日 157 支的逐支身份事后
  不可精确复原**。可复核的替代证据：①`.dev/td260-deleted-evidence.json`（事后
  重建的超集：463 个"转录含 read_only_declared 且分支已不在"的 runId——含
  0057/0060 等历史批次清理与本批，上界性质）；②`branch -d` 的逐支合并自证；
  ③本节判据代码可复查。后续同类清理必须先落逐支证据再删除（本节教训入册）。
- **机制生效的现场证据（同日）**：审核轮双席（opus `run_202610112242214663v8tmb`/
  sol `run_202610112242214879is7h8`）转录均含 `run.worktree_released`+
  `run.worktree_branch_recycled`——MCP server 已载新代码，丙′ 在真实会审通道
  闭环（opus 审核预言的现场验证点，命中）。
