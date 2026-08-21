# TD-130 根因取证报告（R23-E，2026-08-21）

- **任务**：R23-E 计划 v2（`.dev/plans/2026-08-21-round23e-td130-forensics-v2.md`）的执行——两席方案会审定稿（coder_mm `run_202608211939237928p9qut` + auditor `run_20260821193911129wwjcbo`）的取证实施。
- **性质**：纯研究报告。**零生产代码改动**；唯一豁免动作 = D0 清除 `%TEMP%\wao-canonical-test.inflight` 孤儿标记（快照先行，实验卫生）。
- **交付物**：本文档（唯一改动文件）。
- **时钟约定**：正文一律 UTC（与 run 转录 `ts`、runId 内嵌时间同钟）；本机本地时 = UTC+1。两席结论直接引用复用（P1-P4 已实证事实不重新发现），本轮新增证据均给出可复核锚点（转录 seq / 文件路径 / 代码行号）。

---

## 0. 执行摘要

1. **isolation_pass 家族（族 1）的直接机制确认为"同机双全量并发互踩"**：今日抓到一对完整碰撞实例——jgkf6c 直连全量（12:06:42–12:29:29Z）× ngym3n harness 验证全量（12:08:30–12:28:32Z）**重叠约 20 分钟**，前者慢 2.85×（1367s vs 同 worktree 复跑绿 477s）并产出 mcpWorkspaceSmoke isolation_pass，后者被拖过 1200s 验证墙强杀。
2. **command_timeout 子族（族 2）确认为独立族**：今日 3 例全部是 harness lane、全部死在 filesystem 波内（tail 止于 `wave=filesystem start`，210–211 字节，零分类行）。pure 波同日摆幅 **33.7s→204.2s（6.1×）** 证明机器负载态剧烈漂移；filesystem 波长杆（实测绿态 488–696s、污染态 1123s）× 负载高峰 ⇒ 撞 1200s 墙是算术必然。
3. **孤儿标记成因链全程闭合（本轮新证据）**：rqmoy worker 于 11:12:28Z 后台直连自跑全量（无人收割）→ pid 32764 于 11:12:30.251Z 写全局标记 → worker 回合结束、run 完成收割会话，后台任务树被硬杀（harness 任务输出文件留有 `[killed]` 字样）→ `end()` 未执行 → **孤儿标记恒亮 9 小时+**（11:12:30Z → 本轮 21:14 D0 清除），期间 dmyd 自跑、dsfi8 自跑、两席核验全部看到死 pid 的 WARNING。
4. **D 系列受控实验（D0→D1→D-TEMP→D3）预算内全部完成（实耗 ≈4 分钟/40 分钟），单文件形状均未复现家族失败**：错峰 ×5 全绿、私有 TEMP vs 默认 TEMP 全绿（默认 TEMP 反而中位慢 ~40%）、16 路满载 CPU 下全绿。复现需要波级 I/O 交织或双全量碰撞（D2 按计划砍除，未测）。
5. **验收**：`npm test` 全量 exit 0，verdict=pass 227/227，runsGuard=clean，**无 WARNING**（D0 清孤儿后活体证明）。台账 12 行（底稿 6 + 今日 6）；identity_lost 计 7 个实例（底稿 2 + 今日 5）。

---

## A. 实例台账

### A.0 台账口径

- **底稿** = `docs/tech-debt.md` TD-130 登记行的具名实例（R16–R21 五轮事件），不从零重建；**今日 6 事件**按实况并入。
- marker 三态按计划 v2：`fired-on-live | fired-on-orphan | not-fired-because-blind`（核对 WARNING 行内 pid/ts 与真实并发会话）。执行中补充两个必要的记账值：`not-fired-clean`（跑时机器上无标记在场——健康态，非盲区）与 `机制未存在`（2026-08-20 R22 W1 落地前的事件，标记系统尚不存在，等价 blind）。这是对三态分类的忠实细化，不是改写。
- failureCode 三族分列：`command_failed`（含其中再分类的 isolation_pass/stable_fail）/ `command_timeout` / `runs-guard RED`。三族不混计。
- identity 取值：`可复原` 或 `identity_lost + 灭失原因`（强制填写）。

### A.1 底稿实例（TD-130 登记行，R16–R21）

| # | 文件 | 波次(类) | 日期/轮 | lane + tempPerAttempt | marker 观察 | 关键耗时 | failureCode 族 | identity | 证据质量 |
|---|------|----------|---------|------------------------|-------------|----------|----------------|----------|----------|
| B1 | mcp-surface/mcpBind.test.js | filesystem(git) | 08-18 R16 reverify | harness 验证，tempPerAttempt=true | 机制未存在（R22 前置） | 单文件隔离复跑 **721300ms**（与 reverify 事件吻合） | command_failed→isolation_pass | **可复原**（保留树 test-results.json 定谳） | 高（artifact+时长双吻合） |
| B2 | isolation-infra/backgroundRunner.test.js | process | 08-18 R17 Lead 全量 | Lead 手跑，直连 | 机制未存在 | 未记录 | command_failed→isolation_pass（控制台口径） | **identity_lost**（灭失原因：控制台观察口径，无 artifact；报告被复跑覆盖） | 低 |
| B3 | mcp-surface/mcpWorkspaceSmoke.test.js ×3 | filesystem(git) | 08-19 R21 连续两轮全量 + 单跑×3 绿 | harness 验证为主，true | 机制未存在 | 8 路并发复现不现形 | command_failed→isolation_pass | 文件级**可复原**（登记在案）；轮次证据部分被绿跑覆盖 | 中 |
| B4 | backends/processBackend.test.js | pure | 08-19 lane-b3 worker 自跑轮 | worker 自跑，直连 | 机制未存在 | 未记录 | command_failed→isolation_pass | **identity_lost**（灭失原因：控制台口径，Lead 顺序复跑 fail 0 无法回放现场） | 低 |
| B5 | run-lifecycle/runWait.test.js | filesystem(git) | 08-19 验证轮 + reverify 轮 | harness 验证，true | 机制未存在 | 未记录 | command_failed→isolation_pass | 可复原（登记在案） | 中 |
| B6 | delivery/mcpRunDeliveryReverify.test.js | filesystem(git) | 08-19 集成终验轮 | harness 验证，true | 机制未存在 | 未记录 | command_failed→isolation_pass | 可复原（登记在案） | 中 |

底稿当日（08-19）共 5 文件 × 8 轮次、两轮走到 reject+前作集成——登记行原文，此处入账为家族背景。

### A.2 今日 6 事件（2026-08-21，全部 UTC）

**时间线总览**（并发由区间重叠计算）：

```
11:12:28.509  rqmoy worker 发后台直连自跑（bg b0co09x3h，Tee→%TEMP%\wao-fulltest-r23c.log）
11:12:30.251  pid 32764 写全局 inflight 标记（孤儿起点）
~11:13:03     tee log 戛止（pure 波 failed=2 33.7s 后、filesystem 波 start 行为最后一行）
~11:13:27     run 完成 → 会话收割 → 后台树硬杀（任务输出文件留 "[killed]"）→ end() 未执行 → 孤儿诞生
11:13:32──11:23:27  E3 rqmoy harness 验证 FAIL 225/2（与孤儿套件波级重叠≈0，见 E3 注）
11:59:16      jgkf6c 跟进修复轮启动
12:06:42──12:29:29  E1 jgkf6c 全量 FAIL 226/227（mcpWorkspaceSmoke isolation_pass）
12:08:30──12:28:32  E4 ngym3n harness 验证 command_timeout   ← E1×E4 重叠≈20min（真并发对）
12:32──12:40:06  jgkf6c 复跑 PASS 227/227 total=477428ms（同 worktree 顺序复跑即绿）
12:43:43──    ngym3n reverify PASS 831s
13:38:37──13:52:39  dsfi8 worker 直连自跑 PASS 842s（WARNING fired-on-orphan 可见）
15:01:20──15:20:01  dsfi8 harness 验证 PASS 1121s            ← 与 E2 重叠≈17-19min（真并发对）
~15:03──~15:26  E2 dmyd worker 直连自跑：pure 绿 58.2s，filesystem 波 FAIL=2 1122794ms
15:17:51──15:32:24  dmyd harness 验证 PASS 872s              ← 与 E2 尾部重叠≈5-9min；PASS 报告覆盖 E2 现场报告
17:48:21──18:08:23  E5 ciijxe 验证 command_timeout（pure 57155ms）
18:09:16──18:29:19  E6 ciijxe reverify command_timeout（pure 143588ms；18:30:13 为同一结果重复持久化）
19:40:47      两席核验：孤儿仍在（pid 32764 已死）
21:14         本轮 D0：快照+清除孤儿（快照件 %TEMP%\wao-canonical-test.inflight.snapshot-20260821-r23e）
21:19──21:30  本轮 npm test 全量 PASS，无 WARNING（D0 效果活体证明）
```

| # | 文件/波次 | 墙钟起止(UTC) | 并发(重叠计算) | lane + tempPerAttempt | marker 三态 | 各波耗时(负载代理) | failureCode 族 | identity | 证据质量 |
|---|-----------|---------------|----------------|------------------------|-------------|--------------------|----------------|----------|----------|
| E1 | mcp-surface/mcpWorkspaceSmoke.test.js [git/filesystem]；verdict 226/227 | 12:06:42–12:29:29Z（total=1367083ms） | **2**（×E4 ngym3n 全量，重叠≈20min） | worker 自跑（r23c-absorb 会话 jgkf6c 在 rqmoy worktree 手跑），**直连，false** | **fired-on-orphan**（suite 起跑打 WARNING "started at 11:12:30.251Z (pid 32764)"，该 pid 已于 ~11:13:27 死亡——死 pid 警告） | pure 47.0s（正常）；总墙钟 1367s = 同 worktree 复跑绿 477s 的 **2.85×**（慢在被并发拖长的 filesystem 波+隔离复跑段） | command_failed→isolation_pass | **可复原**（isolation 行全文在案：`[canonical] isolation mcp-surface/mcpWorkspaceSmoke.test.js [git/filesystem] firstRound=fail alone=pass ⇒ isolation_pass`，jgkf6c seq214 + bg 任务输出 bxn1kmhd6.output 双源） | **高（今日唯一身份可复原例，两席认定的真锚）** |
| E2 | dmyd worktree filesystem 波 **failed=2**（文件名不可知） | 14:52:48Z 起（dmyd seq415/416 实锚；fs 波 ≈14:55–15:14Z 完成于 15:15:48Z 前——seq444 实证）；原稿 ~15:03 起点与 fs=1122794ms 推算同 seq444 冲突，按审计 F3 修正 | **2**（×dsfi8 harness 验证 15:01:20–15:20:01，重叠≈17-19min；尾部另×dmyd 自己的验证 15:17 起） | worker 自跑（dmyd），**直连，false** | **fired-on-orphan**（起跑 WARNING 同 pid 32764 死 pid） | pure 58180ms 绿；**fs 波 1122794ms exit=1 pass=68 failed=2**（绿态参照 488005–696066ms，污染态 1.6–2.3×） | command_failed（推定 isolation_pass×2——直连套件无 tail 持久化，无法证实分类） | **identity_lost ×2 实例**（灭失原因：①转录只有两次增量部分读、无 verdict/isolation 行；②保留树 test-results.json 被 15:32Z dmyd PASS 验证覆盖） | 低（仅波级计数在案） |
| E3 | rqmoy harness 验证 FAIL 225/2：`isolation-infra/layering.test.js [pure]` + `registry-roles/reliabilityMatrix.test.js [timeout]` 均 stable_fail | 11:13:32–11:23:27Z（total=594101ms） | 1（孤儿套件已于验证起波前 ~5s 被杀——波级重叠≈0，但机器刚经历强杀扰动且孤儿标记在场） | harness 验证，**true** | **not-fired-because-blind**（全局孤儿在场但私有 TEMP 结构性不可见） | pure 35965ms / fs 488005ms / mcp 20664ms / process 48136ms / lock 501ms / timeout 298ms | command_failed→stable_fail×2 | 文件级可复原（stderrTail 全文在案）；**环境贡献度灭失**（alone 复跑在同一窗口内进行，负载态不可回放）；后续跟进轮证实两文件确有真实缺陷（providerFingerprint.js 未进分层登记 / matrix.mjs 断言破坏）⇒ 家族归因：**非 isolation_pass 族，作为伴随事件独立入账** | 高（W1 tail 取证首次实战生效） |
| E4 | ngym3n harness 验证 command_timeout | 12:08:30–12:28:32Z（durMs=1201893 = 1200s 墙 + 杀进程开销） | **2**（×E1，重叠≈20min） | harness 验证，**true** | **not-fired-because-blind** | pure **204238ms**（基线簇 47–59s 的 3.5×）；tail 止于 `wave=filesystem start` ⇒ 死在 fs 波内 | **command_timeout** | **identity_lost**（灭失原因：结构性——超时强杀发生在任何 isolation 分类行打印之前；stderrTail 仅 211B） | 高（事件本身铁证）/ 低（身份） |
| E5 | ciijxe 验证 command_timeout | 17:48:21–18:08:23Z（1201809ms） | ≤1（无可证并发套件；xq9c48 会话 17:55–18:04 在场但未见跑测证据） | harness 验证，**true** | **not-fired-because-blind** | pure **57155ms**（正常）；死在 fs 波内 | **command_timeout** | **identity_lost**（同 E4，结构性） | 高/低 |
| E6 | ciijxe reverify command_timeout | 18:09:16–18:29:19Z（1203544ms；18:30:13 重复持久化） | ≤1（同上） | harness 验证，**true** | **not-fired-because-blind** | pure **143588ms**（2.5×，且 E5 被杀后仅 53s 起跑——残余状态扰动嫌疑，不可证）；死在 fs 波内 | **command_timeout** | **identity_lost**（同 E4） | 高/低 |

### A.3 计数声明（**stage 4 双席审计后修订**）

- **台账行数：13 行**（底稿 B1–B6 + 今日 E1–E7）。
- **E7（审计 F5 补登）**：孤儿套件（rqmoy worker 后台自跑，pid 32764）的 tee log 实证 `wave=pure done exit=1 pass=132 failed=2 33723ms`——比 30 秒后同 worktree 的 harness 验证（E3：pure `failed=1`，且 isolation 行确认 pure 波只有 layering 一个 stable_fail）**多一个首轮流红、复跑未再现、文件名不可知**的失败——家族形状。identity_lost；灭失原因 = 后台任务被硬杀 + tee log 止于 fs 波 start + 无 verdict/isolation 行。**波次注意：E7 落在 pure 波、直连 lane——是"实例向 filesystem 波聚集"（C.2）的当日反例**，也是 F2（降 fs 波并发）收益主张的潜在反证。
- identity_lost 计数按认识论状态分列（审计 F4）：**身份灭失（确有失败实例、文件名丢失）5 个**（B2、B4、E2×2、E7）＋**无身份可言（套件在任何分类行打印前被强杀，连"有没有文件红"都未确立）3 个**（E4、E5、E6）——原稿"计 7 个实例"的聚合口径会把族 1 出血高估 3 个。
- 今日 isolation_pass 实例合计：**1 确证（E1，jgkf6c mcpWorkspaceSmoke）+ 2 推定（E2×2，无法证实分类）+ 1 灭失候选（E7）**；E3 经实证修正改列"伴随事件"（真缺陷：layering/reliabilityMatrix stable_fail，跟进轮 7 行修复坐实，非家族事件）。
- runs-guard RED 族：今日 **0 例**（在案各跑 runsGuard=clean 全部核过）。

---

## B. 标记系统诊断

### B.0 标记系统现状（代码锚点）

- 机制本体：R22 W1 advisory inflight 标记，`scripts/canonical-test.mjs:419`（`INFLIGHT_MARKER_FILENAME`）、`:438-474`（`createInflightMarker` 纯核）、`:482-495`（真实适配器，`join(tmpdir(), …)`）、`:733-739`（`main()` 中 begin/finally-end）。
- 设计语义：**advisory 非锁**——第二套件起跑时打一行 WARNING（`:447`），永不阻塞永不等待；只删自己 O_EXCL 认领的那份（`owned` 标志，`:450-472`）。
- 已知边界自述：头注释 `:94-95` 明认"crashed run leaves an orphan whose only consequence is the same WARNING on later runs"。

### B.1 三态判定规则（含今日分布）

| 态 | 判定规则 | 今日实例 |
|----|----------|----------|
| fired-on-live | WARNING 行内 pid 存活，或 startedAt 与真实并发会话起跑吻合 | **0 例**（今日所有 WARNING 都是死 pid） |
| fired-on-orphan | WARNING 行内 pid 已死/时间戳陈旧——报警疲劳源 | E1（12:06 起跑打到 11:12:30Z 死 pid）、E2（15:03 同）、dsfi8 自跑（13:38 同）；孤儿寿命 11:12:30Z→21:14 清除，**≈9 小时（11:12:30Z→20:14:01Z，快照 CreationTimeUtc 实测）** |
| not-fired-because-blind | 该 lane 结构性看不到机器全局标记 | E3、E4、E5、E6（全部 harness lane，tempPerAttempt=true）——**今日 4/6 事件对标记系统不可见** |
| （补）not-fired-clean | 跑时机器无标记在场，直连可见而未见——健康态 | 本轮 21:19 npm test（D0 清孤后，无 WARNING） |

**核心发现：今日没有任何一次 WARNING 是活体告警。** 标记系统今日的全部输出要么是对死进程的重复误报（报警疲劳），要么因盲区根本没输出。

### B.2 四机制诊断

#### 机制① per-attempt TEMP 私有化（已实证，代码级）

`src/deliveryVerification.js:224-231` `_prepareAttemptEnv()`：每次验证命令（setup/assertion 各算一次 attempt）`mkdtemp(join(tmpdir(), "wao-verify-"))` 并把 `TMP/TEMP/TMPDIR` 整体注入子进程环境。后果三层：

1. canonical 的标记路径 `join(tmpdir(), …)`（canonical-test.mjs:482-484）随之**私有化**——harness lane 的标记落在一次性 `wao-verify-*` 目录里；
2. 于是 harness 套件对机器全局标记**结构性失明**（今日 E3-E6 四例无一见到已在场的孤儿）——R22 W1"同机第二套件打 WARNING"的保护对验证 lane **完全不生效**；
3. harness-vs-harness 亦互不可见：两个并行验证各自写各自的私有标记，互不打 WARNING。

旁注：`deliveryVerification.js:238-246` `_cleanupAttemptEnv` 是 best-effort `rm -rf`——私有孤儿通常被它吸收（不可见也不持久），rm 失败时随目录残留。今日 3 例 harness 超时的强杀孤儿即属此类（被清理，未观测到残留）。

#### 机制② orphan 污染 + 成因链（已实证，今日全程闭环）

**今日实证的全链**（每一环都有 artifact 锚点）：

```
worker 后台直连自跑（无人收割）          rqmoy seq756, 11:12:28.509Z, bg b0co09x3h
  ↓ 1.7s
pid 32764 写全局标记                     标记内容 {"pid":32764,"startedAt":"2026-08-21T11:12:30.251Z"}（D0 快照在案）
  ↓ 33s（pure 波 failed=2，tee log 止于 fs 波 start 行）
worker 回合结束/run 完成 → 会话收割       rqmoy 生命周期事件 11:13:27Z
  ↓ 硬杀后台任务树
end() 永不执行（finally 属于优雅退出路径）  harness 任务输出文件 b0co09x3h.output 内容 = "[killed]"
  ↓
孤儿恒亮 ≈9h01m，跨 4 个后续直连套件误报     dmyd/jgkf6c/dsfi8 WARNING 行 + 两席 19:40 核验 + 本轮 21:14 D0 快照
```

**"timeout 家族在主动降解标记系统"的精确化**（对计划 v2 成因链的修正补充）：
- `command_timeout` 强杀（`deliveryVerification.js:102-104` → `_killProcessTree` → Windows `taskkill /PID x /T /F`，`:186-199`）确实绕过一切优雅退出路径——这一半成立；
- 但 harness lane 的标记已被机制①私有化，其超时孤儿通常被 `_cleanupAttemptEnv` 吸收，**不会**造成全局孤儿。今日的全局孤儿来自**直连 lane 的会话收割硬杀**（worker 后台自跑无人收割），不是 harness 超时；
- 降解的准确表述是：**标记系统的两个设计前提——"所有 lane 共享同一 tmpdir 视图"与"套件总以优雅退出收尾"——在今天四类场景（harness 盲区×4、直连强杀×1、超时强杀×3）下全部不成立**。超时强杀族虽不直接制造全局孤儿，但它每杀一次就证明一次"依赖优雅退出"的删除策略在最需要的时刻失效。

#### 机制③ 先完成者删共享标记洞（代码证实，今日未触发）

`createInflightMarker` 的 `begin()` observed 分支置 `owned=false`（canonical-test.mjs:453），`end()` 只在 owned 时删除（`:468-472`）。推演洞：A 认领并起跑 → B 起跑只见 WARNING 不认领 → A 先完成删标记 → C 再起跑**什么都看不见**，尽管 B 仍在跑。标记是"单创建者所有"模型，无引用计数。今日 6 事件未触发此洞（没有 C 形状的第三套件落在 A 终-B 末窗口内），登记为代码级存在的潜在盲区。

#### 机制④ 绿跑结构性不可判定（代码证实）

`deliveryVerification.js:131-132`：stdout/stderrTail **仅非成功结果**携带内容；`:262-273` `_recordResult` 结构性强制绿结果 tail=""（3B-07/3B-25 契约）。canonical 的 WARNING/isolation 行全部走 stderr。因此：**绿跑是否见过 WARNING、是否处于污染窗口、当时多慢——持久化面上永远不可判定**。台账凡绿跑行的负载/标记列只能标 undecidable；E2 的 identity 灭失正是此机制 + 报告覆盖的合成后果。

---

## C. 模式分析

### C.1 三族分开统计（今日）

| 族 | 形状 | 今日事件 | 实例数 | lane 分布 |
|----|------|----------|--------|-----------|
| 族1 isolation_pass | exit 1 + 分类行全为 isolation_pass | E1、E2 | 3（1 可复原 + 2 灭失） | 直连×2 事件（worker 自跑）；harness 验证今日 0 例 |
| 族2 command_timeout | exit null + timedOut，tail 止于某波 start 行 | E4、E5、E6 | 3 套件（ciijxe 含验证+reverify 连撞） | **harness 验证 3/3** |
| 族3 runs-guard RED | runsGuard=RED(+n) | 无 | 0 | — |
| 伴随事件 | stable_fail×2（真实红） | E3 | 2 文件 | harness 验证 |

**族 1 与族 2 今日零重叠、不同 lane、不同机制**——两席"三例 command_timeout 疑似不同族"判断成立，且进一步：族 2 全部是 harness lane 的墙钟问题，族 1 全部是直连 lane 的争用问题。

### C.2 波次/文件聚集

- 底稿 6 具名文件：**4/6 在 filesystem 波**（mcpBind、mcpRunDeliveryReverify、mcpWorkspaceSmoke、runWait 全是 git 类，pooled 进 git+worktree @16 并发波），1/6 pure（processBackend），1/6 process（backgroundRunner）。今日 E2 的 2 个灭失实例也在 filesystem 波。manifest 定位命令与结果见附录 G.2。
- filesystem 波的三重唯一性：唯一做真实 git/worktree I/O 的波 + 最高并发（16）+ 最长时长（今日实测绿态 488005–696066ms，污染态 1122794ms）。**家族实例向它聚集与"资源争用"假设一致**。
- 为什么是 mcpWorkspaceSmoke×4（含今日）：它是 filesystem 波里少数做 MCP workspace 真实落盘 + 固定 sleep 时序断言（200/200/100/100ms，L186/217/284/297）的文件——I/O 抖动直接转化为断言失败概率。

### C.3 断言类型（读测试源码；如实声明数据面缺失）

| 文件 | 时序敏感面（源码行号） | 性状 |
|------|------------------------|------|
| mcp-surface/mcpWorkspaceSmoke.test.js | 固定 sleep 200/200/100/100ms（L186/217/284/297） | 真实 fs + MCP workspace 落盘后定时检查——负载下最易破 |
| backends/processBackend.test.js | silentTimeout=300ms + **elapsed<2000ms 墙钟断言**（L361/370）、abort@100ms（L281）、sleep 50ms（L262） | 显式墙钟上限断言，慢机器直接红 |
| isolation-infra/backgroundRunner.test.js | waitTimeout 1000–5000ms 配置 + 真实 CLI spawn `timeout:10000`（L58/102/133-134/194/226/279/337） | 子进程墙钟敏感 |
| run-lifecycle/runWait.test.js | sleep 注入 fake（L59/101…），L397 注释"avoid 60s MCP client timeout" | 大部分逻辑时间可控，敏感度较低 |
| mcp-surface/mcpBind.test.js | 42 tests，**零显式超时常量**（grep 证空）——时长来自 src 层 MCP 超时 | 最重文件：单文件隔离复跑实测 721300ms（B1） |
| delivery/mcpRunDeliveryReverify.test.js | backoff sleep 60×(attempt+1)ms（L56）+ REVERIFY_TIMEOUT_MS_MIN/MAX 断言 | 温和 |

**如实声明（计划 v2 要求）**：本报告**没有 per-file 时长数据面**。reporter.mjs 内部采集了 suite duration（test/reporter.mjs:57 `duration: 0`、`:73` `suite.duration += entry.duration`），但 canonical-test.mjs:563 映射报告时只持久化 `{path, status, resourceCategory, executionWave}`——per-file 时长在映射处被丢弃，test-results.json 只有波级 `durationMs`。因此"家族文件哪个更慢/何时变慢"只能靠波级聚合 + 事后单文件复跑实测（如 B1 的 721300ms），无法从既有 artifact 直接读出。这本身是一个廉价可修的观测缺口（见 E.2-F4）。

### C.4 pure 波时长离散度（同日同 134 文件集合——家族负载证据）

| 时刻(UTC) | 归属 | pure 波耗时 | 相对基线簇 |
|-----------|------|-------------|------------|
| 11:12:30 | 孤儿套件（tee log） | 33723ms | 0.6×（独占机） |
| 11:13:32 | E3 rqmoy 验证 | 35965ms | 0.7× |
| 12:06:42 | E1 jgkf6c | ~47037ms | 1× |
| 12:08:30 | **E4 ngym3n 验证** | **204238ms** | **3.5–4.3×（与 E1 并发中）** |
| 13:38:37 | dsfi8 自跑 | 59378ms | 1×（孤儿在场但不并发） |
| ~15:03 | E2 dmyd 自跑 | 58180ms | 1×（前半程；后半程与 dsfi8 验证并发） |
| 17:48:21 | E5 ciijxe 验证 | 57155ms | 1× |
| 18:09:16 | **E6 ciijxe reverify** | **143588ms** | **2.5×（无可证并发——负载漂移不可归因样本）** |
| 21:19:19 | 本轮验收 | 54207ms | 1×（清孤后干净机） |

离散度 **33.7s→204.2s = 6.1×**；两个异常值一个可归因（E4×E1 真并发），一个不可归因（E6，起跑于 E5 强杀 53s 后——残余扰动/AV 重扫嫌疑，不可证）。**结论：这台机器的负载态在同日内剧烈漂移，且漂移量级足以把 filesystem 波长杆推出任何固定验证墙。** 这就是族 2 的算术基础：fs 波绿态 488–696s × 负载系数 2–3× ⇒ 1000–2100s，横跨 1200s 墙两侧。

---

## D. 受控实验

预算 **40 分钟**，优先序 D0→D1→D-TEMP→D3。**实际 D 系列总耗时 ≈4 分钟（预算内全部完成，无需截断）**。红线遵守：零生产代码改动；唯一豁免动作 D0（快照先行）；实验全部在本 worktree / 用户 TEMP 进行，未触碰真实 `runs/`、未动 `src/mcp/`、无 git 写操作。

> **lane 保真度声明**：D1–D3 单文件直跑用的是系统 node v24.13.1（按任务指定命令形状 `node --test <file>`；未显式设 WAO_SKIP_VERSION_GUARD，所跑两文件不触发版本守卫，全部 exit 0）。canonical 全量 lane 经 wao-node.cjs shim 走 Node v22。单文件形状也不经过 canonical runner（无波调度、无标记交互）——这正是实验设计要隔离的变量。

### D0 孤儿快照/清除（每实验前后卫生检查）

```
PS> Test-Path "$env:TEMP\wao-canonical-test.inflight"        → True
PS> Get-Content "$env:TEMP\wao-canonical-test.inflight"      → {"pid":32764,"startedAt":"2026-08-21T11:12:30.251Z"}
PS> Copy-Item ... ".snapshot-20260821-r23e" ; Remove-Item ...（红线豁免动作）
PS> Test-Path ... （清除后）                                  → False
```

前后对照：**前 = 孤儿在场**（pid 32764，创建于 11:12:30Z+1 本地，53 字节）；**后 = absent**。此后每个实验结束复查均为 False（原始输出见各行尾 `--- orphan check:`）；全部实验 + 全量验收结束后终查仍为 False——**无新孤儿产生**。快照件留存 `%TEMP%\wao-canonical-test.inflight.snapshot-20260821-r23e`。

### D1 单文件错峰基线 ×5（mcpWorkspaceSmoke + processBackend）

```
PS> foreach ($i in 1..5) { node --test test/mcp-surface/mcpWorkspaceSmoke.test.js }
mcpWorkspaceSmoke run 1: exit=0 dur=4085ms
mcpWorkspaceSmoke run 2: exit=0 dur=4212ms
mcpWorkspaceSmoke run 3: exit=0 dur=4777ms
mcpWorkspaceSmoke run 4: exit=0 dur=5419ms
mcpWorkspaceSmoke run 5: exit=0 dur=8392ms

PS> foreach ($i in 1..5) { node --test test/backends/processBackend.test.js }
processBackend run 1: exit=0 dur=5367ms
processBackend run 2-5（笔误修正）: exit=0 dur=2954/3011/3220/3060ms
--- orphan check: False
```

**结果：10/10 全绿。** 附带观察：mcpWorkspaceSmoke 同臂内漂移 4.1→8.4s（2.05×）——单臂 n=5 内就有接近负载效应量级的噪声，提示小样本时长对比须谨慎（也削弱把 D-TEMP 差异读死为因果的信心）。

### D-TEMP 私有 TEMP vs 默认 TEMP（替代被砍 D2 的 harness-vs-直连形状对照）

```
PS> $priv = "$env:TEMP\wao-verify-dtemp-<rand>"; mkdir; $env:TMP/TEMP/TMPDIR=$priv;
    node --test test/mcp-surface/mcpWorkspaceSmoke.test.js ×3；还原 env；
    默认 TEMP 臂 ×3
private-TEMP  1: exit=0 3579ms   default-TEMP  1: exit=0 4338ms
private-TEMP  2: exit=0 3957ms   default-TEMP  2: exit=0 5569ms
private-TEMP  3: exit=0 4399ms   default-TEMP  3: exit=0 8600ms
--- orphan check: False
```

**结果：6/6 全绿。** 中位 private 3957ms vs default 5569ms（default 慢 ~41%）——方向与"全局 TEMP 污染（数千个陈旧 wao-audit-* 目录）拖慢直连 lane"一致，**但与运行顺序混杂（default 臂后跑）且 n=3，不作因果定论**，列为待专门预算的候选因素。注意真实 harness 形状比本实验更重（cmd.exe shell 包装 npm→shim 两层间接），本实验测的是 TEMP 变量本身。

### D3 合成 CPU 负载（区分并发互踩 vs 纯负载时序）

```
PS> 16 路（=逻辑处理器数）Start-Process node '-e' CPU 忙环（240s 上限保险丝）
PS> Start-Sleep 2s 后连跑 ×3：node --test test/mcp-surface/mcpWorkspaceSmoke.test.js
under-load run 1: exit=0 dur=4193ms
under-load run 2: exit=0 dur=5866ms
under-load run 3: exit=0 dur=11462ms
PS> loaders | Stop-Process -Force
--- orphan check: False
```

**结果：3/3 全绿**（减速 1.2–2.7×，无失败）。**负结果有意义：纯 CPU 饱和不足以让家族文件红**——isolation_pass 需要的不只是 CPU 争用，而是波级形态（70 文件 × 16 并发的真实 git/worktree I/O 交织）或双全量碰撞（磁盘 I/O + 内存 + 端口/句柄全维争用）。后者即被计划砍除的 D2，本轮未测。

### D 系列汇总

| 实验 | 预算占用 | 复现？ | 结论 |
|------|----------|--------|------|
| D0 | ~1 min | — | 孤儿清除；全程无新孤儿 |
| D1 | ~1 min | 否（10/10 绿） | 错峰单文件健康；单臂噪声可达 2× |
| D-TEMP | ~40 s | 否（6/6 绿） | TEMP 形状影响时长方向性存在、幅度不足以单独致死 |
| D3 | ~40 s | 否（3/3 绿） | 纯 CPU 负载不足以致家族红 |

未测面（如实登记）：双全量并发（D2，设计砍除——今日已有天然对照 E1×E4/E2×dsfi8 两对真并发数据点）、AV/磁盘 I/O 专项、Node22-shim 形状下的单文件行为。

---

## E. 结论

### E.1 假设排序（附证据强度）

| # | 假设 | 证据 | 强度 |
|---|------|------|------|
| H1 | **同机双全量并发互踩是 isolation_pass 家族的直接机制** | 今日一对完整真并发碰撞（E1×E4 重叠 20min：E1 慢 2.85× 且产出家族形状红、E4 撞墙亡）+ 第二对（E2×dsfi8 验证重叠 17-19min，E2 fs 波 failed=2）+ 08-19 五文件×八轮并行实证（登记行）+ D3 负结果反证（纯 CPU 不够，需 I/O 全维争用） | **高**（机制+时间线闭环；缺 D2 形状直接复现） |
| H2 | **command_timeout 独立子族 = filesystem 波长杆 × 负载漂移 × 1200s 墙** | 3/3 死在 fs 波内（tail 形状一致）；pure 波 6.1× 日内漂移证明负载系数存在；fs 波 488–1123s 实测区间 × 漂移系数横跨 1200s | **高**（算术闭环 + 3/3 形状吻合） |
| H3 | **标记系统四机制失效**（per-attempt 盲区 / 孤儿 / 先完者删共享洞 / 绿跑不可判定） | 代码行号在案（B.2）；今日全程观察：WARNING 全为死 pid 误报、harness 4/6 事件不可见、孤儿寿命 ≈9h01m | **高**（这是"为什么一直看不见"，不是根因本身） |
| H4 | TEMP 形状不对称放大直连 vs harness 差异（全局 TEMP 污染拖慢直连侧） | D-TEMP 方向性支持（default 慢 ~41%，混杂未消） | 中 |
| H5 | AV / 磁盘 I/O 专项因素 | E6 型不可归因漂移 + D-TEMP 佐证 | 低（本轮未测，需专门预算） |
| H6 | ~~单文件固有时序脆弱~~ | 底稿曾疑（sleep 断言面），D1/D3 十三次全绿不支持其为充分条件 | 低（必要非充分） |

一句话根因模型：**族 1 = "两套全量在同一台机器上互相踩踏，filesystem 波首当其冲"；族 2 = "同一台机器的负载漂移把 filesystem 波长杆推过固定验证墙"；标记系统则是被这两个族反复穿过的、已经失明的警报器。**

### E.2 修复候选（附代价）

| # | 候选 | 动作面 | 代价 | 收益 | 备注 |
|---|------|--------|------|------|------|
| F1 | marker pid 存活检测 | canonical-test.mjs `warnExisting`（:440-449）加探活（`process.kill(pid,0)`，Windows 对死 pid 抛 ESRCH 可判）；死 pid ⇒ 降级为 `[canonical] NOTICE: stale orphan marker (pid dead since …)` | 小（单函数+meta 测试）；风险低；pid 复用理论窗口存在 | 治报警疲劳：死 pid 不再伪装成并发警告，操作员不再需要人肉核 pid | 纯诊断增强，不改失败语义 |
| F2 | filesystem 波降并发 16→8 | canonical-test.mjs:151 常量 | 全量 **≥+34s**（@8=212s vs @16=178s 实测在案 ：139-143；54 文件旧基准，今日 70 文件更高） | **[stage 4 修订]** 仅假设性降压族 1（互踩面减半）；族 2 被实测证据反向（全量更长离墙更近）；@8 系实测记录否决过的值 | 生产代码改动，本轮不动；若考虑须先补 70 文件受载实测 |
| F3 | 抬 verificationTimeoutMs 1200s→1800s | Lead 参数（MAX=7,200,000，src/delivery.js:41，零代码） | 最坏多等 10min/验证；**稀释"当时有多慢"信号** | 只降族 2 频率，不降触发面 | **计划 v2 红线：本轮禁抬**（保证据） |
| F4 | per-file duration 持久化 | canonical-test.mjs:563 映射处加透传 reporter 已采集的 suite.duration | 极小 | 下次家族事件自带"哪个文件慢"数据面，消灭 C.3 声明的观测缺口 | 观测补强，与 F1 同批顺手 |
| F5 | worker 全量自跑纪律：同步等待/轮询到退出码 | 流程 + prompt 模板（jgkf6c 跟进轮已如此要求——实践已在收敛） | 零代码 | 斩断今日孤儿成因链的第一环（无人收割的后台自跑） | 编排层可选加"run 完成时有未收割 bg 任务⇒警告"，代价中 |

### E.3 止血预授权提案（呈 Owner 拍板格式，单列；**stage 4 双席审计后修订版**）

> **修订说明**：初版"选项一（波并发 16→8）推荐"经两席审计证伪——其族 2 收益主张与本仓实测调优记录（canonical-test.mjs:139-143）**方向相反**：@8=212s 慢于 @16=178s（降并发使全量更长、离 1200s 墙**更近**，族 2 被加剧而非降压）；且 @8 是该实测记录明确否决过的值（"@8 that failed the target"），+34s 系 54 文件时代的旧测量（今日波已 70 文件，实际更高）。初版同时主张"+34s"与"离墙更远"，二者不能并存。本节按审计意见重写，并新增两席"没问但该问"收敛出的**选项零**。
>
> **触发条件**：① D 系列未复现家族失败——**限定口径：v24 直跑形状下**未复现（D1/D-TEMP/D3 十九跑全绿；注意 v24 是本仓禁用运行时且禁用理由"杀长进程"与被测面重合，负结果外推有 lane 保真度边界）；② 台账确认实例向 filesystem 波聚集（底稿 4/6 具名 + 今日 E2 两例灭失——**E7 为 pure 波反例，见 A 节**）；③ 出血在继续——今日 7 事件已吃掉两轮验证预算（rqmoy 走 reject+修复轮、r23d 验证+reverify 双撞墙）。
>
> **候选择一先行，不等根因结案**：
> - **选项零（Lead 推荐首选，审计"没问但该问"新增）：同机全量验证串行化闸**（机器级 verification 信号量/排队）。今日两对碰撞（E1×E4 相隔 1.8s 并行派发、E2×dsfi8）不是运气——是"并行派发 + 每 run 一次全量验证 + 单机"的算术后果。串行化让碰撞**结构性不可能**，不拉长任何单次跑（只排队：等 ~10 分钟 ≪ 撞墙重跑 20 分钟）。代价：控制面新机制（中等）；验证排队期间 delivery 处于 pending 更久。
> - **选项二：marker pid 存活检测**（初版"选项二"，审计后升格：今日 WARNING 有效率 0/4、harness lane 4/6 事件结构性不可见——这个仪表不是"待增强"，是**正在误导判断**）。代价：小改动+测试。收益：死 pid 降级为 NOTICE，恢复直连口径判别力。
> - **选项一（降为"待实测"候选）：filesystem 波并发 16→8**。拍板前必须知道三件事：(a) @8 曾实测未达交付窗口目标、16 是"舒适达标的最小值"（:139-143 实测记录，属 TD-107 实测纪律的一部分）；(b) +34s 是 54 文件旧测量、今日 70 文件更高；(c) 族 2 收益（受载时降并发或减少争用）是**未经测量的假设**，与空载证据方向相反。若 Owner 仍考虑：先补 70 文件下 @8/@16 受载实测。
> - 选项三：verificationTimeoutMs 1200s→1800s。零代码但每次验证最多多等 10 分钟，且稀释"当时有多慢"的取证信号。仅作族 2 的显式补充。
>
> 一句话版（修订）：**选项零+选项二同批先行（串行化断碰撞源、探活修仪表）；选项一降为待实测；选项三留给 Owner 显式选择。**

---

## F. 文档修正候选（发现登记，不改 docs/troubleshooting.md——归 Lead 处置）

1. **[stage 4 修订——审计 F7：这是缺口不是错误陈述]** §8.1 的症状自述（troubleshooting.md:423）本就把辖区圈定在 exit 1 的 isolation_pass 形状，command_timeout（exit null）不在其自述辖区——原句对 `command_failed` 仍成立。**真正缺口：全文没有 command_timeout 条目，且快速索引入口表（:36-37）无 timeout 路由**——补入口行比改正文更对症。判据内容保留：超时强杀（今日 3 例）发生在任何 isolation 分类行之前，tail 仅含 wave start 行（210–211 字节）；独立条目应为"tail 止于某波 start 行且无 done ⇒ 死在该波内；以已完成波的耗时作负载证据；处置不是错峰 reverify（reverify 单发机会同样撞墙，今日 ciijxe 验证+reverify 双双 timeout 即证），而是降并发/抬墙/择时独占跑"。今日 E4-E6 正是靠"读测试源码超时常量 + 波级聚合"才完成定位的——§8.1 承诺的捷径在这条路上不存在。
2. **§8.1 预防段措辞精化**："标记在所有退出路径删除"应补注"（**优雅**退出路径）——taskkill/会话收割/断电不删，孤儿恒亮直至手工清除"；并补一句直连/harness 视差："harness 验证 lane 因 per-attempt TEMP 私有化（deliveryVerification.js:224-231）对机器全局标记结构性不可见——WARNING 缺席不能证明无并发"。

---

## G. 合规与验收

### G.1 红线遵守声明

- 零生产代码改动（含未抬 verificationTimeoutMs）；`git status --porcelain` 干净度：唯一改动文件为本报告 `docs/research/td130-root-cause.md`（test-results.json 为 .gitignore:16 忽略项）。
- D0 孤儿清除为唯一豁免动作，快照先行（快照件在用户 TEMP，仓外）。
- 真实 `runs/` 只读（检索今日转录），未写入；`src/mcp/` 零字节；无 git 写操作、无 HEAD 移动；改动保持未暂存。
- 实验单文件命令按任务指定形状执行（node v24 直跑的 lane 保真度声明见 D 系列前言）。

### G.2 证据索引（关键 artifact）

- 身份锚：jgkf6c seq214 tool_result + bg 输出 `bxn1kmhd6.output`（isolation 行 + verdict 226/227 total=1367083ms）。
- 孤儿链：rqmoy seq756（bg 启动）→ `b0co09x3h.output`（内容 `[killed]`）→ D0 快照（标记内容）→ dmyd seq429/435/444（WARNING + fs 波 failed=2 部分读）。
- 超时族：ngym3n/ciijxe 各 delivery 对象（failureCode=command_timeout、timeoutMs=1200000、tempPerAttempt=true、stderrTail 210–211B）。
- E3：rqmoy delivery 对象 stderrTail 全文（225/2 + stable_fail×2 + tempPerAttempt=true）。
- 代码：src/deliveryVerification.js:102-104/131-132/186-199/224-246/262-273/430-431；scripts/canonical-test.mjs:94-95/139-156/223-228/405-495/563/717-740；scripts/wao-node.cjs（Node22 shim）；src/delivery.js:40-41；test/reporter.mjs:57/73；test/manifest.json（家族文件类别）。
- 本轮验收：`npm test`（后台任务 bw2z3l233，21:19:19–21:30:33 local，wall=673s）：

```
[canonical] wave=pure start files=134 categories=pure concurrency=8
[canonical] wave=pure done exit=0 pass=134 failed=0 54207ms
[canonical] wave=filesystem start files=70 categories=git+worktree concurrency=16
…
[canonical] verdict=pass discovered=227 executed=227 passed=227 failed=0 missing=0 crashed=0 isolation=0 waves=6 runsGuard=clean total=672809ms ⇒ D:\…\run_202608211953149223smcbv\test-results.json
exit=0 ended 21:30:33 wall=673s   [exited with code 0]
```

（全量无 WARNING 行——D0 清孤后的干净机上直连全量的健康基线，同时是孤儿清除效果的活体证明。）

---

## G. stage 4 审计修订记录（2026-08-21，Lead 补全）

两席审计（auditor run_20260821205214778c4k8zq / coder_mm run_20260821205216278e842zq，均 PASS with changes）逐字节复核：证据底座为真（孤儿链独立闭合、行号全中、E1×E4 重叠 20m02s 反推吻合、rqmoy 改列正确、D-TEMP 自我拆台记功）。修订项：E.3 重写（选项一收益与实测反号→降为待实测；新增选项零串行化闸=Lead 推荐首选；选项二升格）；F2 候选行同步；E2 时窗修正（14:52:48Z 实锚）；A.3 计数按认识论分列+E7 补登（pure 波反例）；孤儿寿命 9h01m；§8.1 改判缺口+入口表方向；707→696s；D 系列结论限定 v24 直跑形状（v24 系本仓禁用运行时，禁用理由与被测面重合——负结果外推边界）。
