# 0063: TD-261/262 批——serve recycle 死实例复活与重启健壮性 + resume 的 ephemeral 恢复

status: accepted
date: 2026-10-12

## Context

Owner 指令（2026-10-12）：TD-261/262 选 now 解决、按老规矩推进（会审→实施→
dogfood→全量→推送）。方案会审 consult_202610120632495208vl98g（opus 6940 字）+
sol 首试 codex 瞬时失败后重试 consult_202610120637265429ayazl（3641 字）。两席
对 Lead 初版方案：D1/D2 修改后同意、D3/D4 现稿反对（各有硬伤），必改项全采纳。

## Decision

1. **D1（261a 死实例复活）**：`serveRequest` 透出连接拒绝分类（error.code /
   cause.code / AggregateError 子错误**全员** ECONNREFUSED 才算——混有其它即
   不可证死）；`listServeSessions` 映射新 reason `connection_refused`（其余保持
   http_error——DNS/超时不可证死维持拒绝）。recycle 首探双面均 connection_
   refused + **实例 pid 已死**（区分"已死"与"启动中未 bind"——opus 条款）+ 隔 3s
   复探仍双拒（双面同刻打同一死端口不是独立证据——opus 条款）→ 判"保护前提为
   空"跳过 soak/shutdown/杀步直接重启；`revived:true` 仅在新实例就绪确认后置真
   （sol 条款）。pid 活 → 新拒绝 `serve_not_listening_pid_alive`；混合结果维持
   既有拒绝（拒绝名闭集不变，连接拒绝细节 ride 在 reason 上）。同端口多实例
   记录（复活后新旧并存）取"pid 存活者中最新心跳"（opus 条款）；taskkill 回退
   前核验进程镜像名含 kimi（防 pid 复用误杀无关进程树）。**边界**：no_instance
   维持拒绝（读错 kimiHome 与从未启动同形——登记不修）；端口被非 kimi 进程占
   会走 upstream_rejected/shape_unknown 拒绝（双席验证）。
2. **D2（261b 重启健壮性）**：exe 解析与 workspaceDir 校验**前移到一切副作用
   之前**（旧实现 shutdown 后才发现没 exe=最糟形状）；显式 `--kimi-exe`=指定
   执行器缺席即拒不降级（sol）；默认链 kimiHome/bin → PATH 扫描（.exe/.com）→
   `%USERPROFILE%\.kimi-code\bin\kimi.exe`（CIM 旧进程 ExecutablePath 候选
   留档未实施——powershell 依赖，链已覆盖实测失败形状）。spawn 'error' 事件
   同步挂上并仲裁（unhandled 'error' event 是当日进程崩根因）；ENOENT 按候选
   降级、非 ENOENT 不降级（权限/损坏——sol）；全候选失败=结构化
   `restart:"failed"`+recycle-ledger 台账行+锁释放+手动配方指路+**no_instance
   死胡同说明**；CLI 对 restart:failed 与 ready:false 均非零退出（旧实现只认
   refused——"spawn 成功但没就绪"以 exit 0 收场=留死 serve 不报）。
   workspaceDir 缺席显式拒（旧实现 git -C 失败被误读为通过+spawn ENOENT 误归
   因 exe——opus 实锤）。
3. **D3（262a 壳扫收分支）**：`sweepEmptyWorktreeHusks` 返回已删壳名数组+改
   **非递归 rmdir**（目录变非空即拒——sol）+lstat 防符号链接/junction。已删壳
   走 `recycleHuskBranches` **转录门控**（sol 反例：accepted 交付轮同样留空壳
   且分支须保留——空目录不是资格证据）：转录在场+终态+run.read_only_declared+
   无 delivery+worktreePath basename===壳名（runId=壳名**原样含 run_ 前缀**——
   opus 纠错）；`git worktree prune` 先行（登记残留会让 -d 恒拒——opus 待实测
   点，测试闭合）；每壳一行 husk-branch-ledger 台账（runId/huskPath/sourceCwd/
   branch/tipSha/outcome/uniqueCommits——tipSha 可机器复原——opus 条款）。无
   run 转录可写事件（run 已终态）——台账即证据落点（sweep 台账同先例）。
   **边界**：扫壳只覆盖 lockRootDir/.wao-worktrees（agent.cwd 在别仓不覆盖——
   登记）；"壳已删、回收前崩溃"的重试入口=周期普查联读台账（.dev 脚本义务）。
4. **D4（262b resume 恢复）**：start 在 run.started 持久化 `worktreeStrategy`
   （"ephemeral"/"persistent"；非 worktree 缺席字节兼容）——**resume 只认此
   字段**（旧转录无字段不恢复交普查；复用轮/交付轮恒 persistent——opus 反例
   边界关闭）。恢复时：deferredWorktreeRelease=worktreePath；**执行位置=隔离树**
   （修"resume 后 worker 跑在源仓"旧缺陷——opus 实锤：replay spawn 用
   spawnAgent 覆写 cwd、attach 轮询用 executionCwd；Run.agent 保持源仓解析供
   分支回收）；树缺失 → refuse resume（零转录写入 fail-closed）。attach 重建
   handle 按 backend 能力位接停止探针（opencode.session/messages 形——不变量
   3；kimi-web 走 replay 臂自带探针）。**停止确认旗以 run.stop_verified append
   成功为准**（sol 实锤：旧实现先置旗再 append，写盘失败仍删树违反 0057 合同
   ——两处修正）。**边界**：非只读 ephemeral 轮 resume 不恢复 cleanupFn（同类
   泄漏，登记）；replay 前 worker 成孤儿的窗口缺进程连带杀证据（登记）；
   终态已落盘但 cleanup 未执行的崩溃窗口 resume 会拒（既有语义）。

## Consequences

- serve 死亡后 `serve recycle` 可直接复活（当日 58628 实测形状）；重启失败
  不再崩溃进程、不再静默留死 serve、退出码如实。
- kimi 车道 still_present 壳经 `serve recycle` 扫壳后连带收分支（转录门控）；
  交付/复用/在跑轮的分支不可误删（测试钉）。
- 崩溃恢复的只读轮不再泄漏树+分支；resume 不再让 worker 落回源仓。
- 会审吸收记录：opus 的 isolation.js:181 "--exclude=${branch} 双引号字面量"
  指控经 Lead 复核为会审页 markdown 渲染吃反引号的误报（源码为模板串）——
  如实记入本档防复发疑惑。
