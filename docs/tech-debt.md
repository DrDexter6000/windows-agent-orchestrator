# 技术债台账

还没了结的事项，一条一行，一行不超过 700 字节。本文件只有这段说明和下面这张表。

- 状态只有三种：`开放`（有明确的剩余工作）、`等待裁定`（要 Owner 先定）、`设计性约束`（刻意的边界，记下来免得重复讨论）。
- 更新一条就是改写它，不往后追加；经过写在提交说明里。一行写不下的细节放进它所属的决定或事故记录，在「指针」列指过去。
- 了结一条：把这一行移到 [`archive/tech-debt-closed.md`](./archive/tech-debt-closed.md)，写上依据。
- TD-269 及以前各条的完整原文在 [`archive/tech-debt-2026-10-13.md`](./archive/tech-debt-2026-10-13.md)。那是冻结的历史，只供查阅，不代表现状。
- 新编号取「本表、已了结清单、`archive/tech-debt-repaid.md`」三处最大编号加一。

| 编号 | 问题 | 状态 | 何时处理 | 指针 |
|---|---|---|---|---|
| TD-13 | 进程终止只走 Windows 的 taskkill，没有跨平台分支；仓库契约把范围限定在 Windows | 设计性约束 | 需要跨平台时 | AGENTS.md |
| TD-16 | 真实 CLI smoke 依赖真实 API、登录与费用，刻意不进 npm test、CI 不跑 | 设计性约束 | 涉及外部系统的 milestone 收尾必跑真实运行时验证（smoke 或该车道的 reliability，见 milestone-discipline §6.1、§6.7） | docs/milestone-discipline.md |
| TD-41 | abort 测试在全量高负载下偶发失败，缺确定性的子进程退出因果判定 | 开放 | 等样本：再次稳定复现时改用 child exit 事件建立因果 |  |
| TD-45 | daemon 自愈已落地，但 supervisor 自身被杀后无法自动重启 | 开放 | 择机：supervisor 重生引导（Windows 服务/计划任务）留 v2 | src/daemonSupervisor.js |
| TD-46 | daemon 长跑累积子进程残留与句柄泄漏的根因未修，仅监控告警就位 | 开放 | 等样本：health warn 实际触发后针对性修 |  |
| TD-47 | daemon IPC 仅请求-响应，tail 依赖文件轮询，无流式推送：决定 0012 有意选的窄协议 | 设计性约束 | 出现真实流式需求时重议（daemon 去留见 TD-368） |  |
| TD-50 | 失败分类是启发式信号匹配，边缘 case 降级 unknown，刻意只给证据不给处方 | 设计性约束 | 新增 provider 错误格式时扩充 AUTH_SIGNAL 即可 | src/diagnosis.js |
| TD-84 | 目标项目未 init 时 `wao declare` / `wao stage` 以 ENOENT 崩溃 | 开放 | 等样本：跨项目派工再次撞到 | src/cli.js |
| TD-96 | `wao stage` 每个阶段要手拼 task、artifacts、cwd；按 run 自动填充（`--from-run`）登记了没做 | 开放 | 等样本：真实使用里再次需要自动填充 |  |
| TD-97 | scorecard 的 requireCommands/requireFiles 证据判定独立于统一评估模块 | 设计性约束 | 刻意边界：核心证据事实已统一于 runEvidenceAssessment，requireCommands/requireFiles 因需 I/O 与复杂匹配留在 scorecard；两套判据漂移实证再重开 | src/runEvidenceAssessment.js |
| TD-104 | 同一 OS identity 下 worker 仍可读取分配的凭据文件，credential broker 未落地 | 开放 | 择机：无人值守、多租户或强隔离发布前做 credential broker 或独立身份 | 0016 docs/incidents/2026-07-12-worker-credential-exposure.md |
| TD-106 | Tester 上下文效率属 Codex 产品与订阅配额问题，WAO 刻意不吸收该职责 | 设计性约束 | 未定 |  |
| TD-115 | lastHealthyRunAt 非 sticky：重跑失败后新鲜度归空，失败场景拿不到上次健康时间；重跑覆盖同 case、失败归 null 是已接受的新鲜度语义 | 设计性约束 | Lead 需要失败场景的上次健康时间时另立 sticky 字段，不改本字段 |  |
| TD-118 | 技能安装是指向仓库根的 junction，改动写盘即生效于所有会话，无提交闸门 | 设计性约束 | fresh clone 后需重新安装 | SKILL.md |
| TD-123 | 全行扫描正则对注释/字符串有假阳性面，application 的 bare 包出边未入方向矩阵 | 开放 | 等样本：首次全行扫描假红实证；触碰 layering 矩阵时顺带补 bare 包出边 |  |
| TD-124 | 静态规则可被单行 join 逃逸、白名单非行内容锚定、深度2写者未覆盖 | 开放 | 等样本：首次真实逃逸实证；触碰守卫/白名单时顺带收紧 | src/application/sessionReuse.js |
| TD-125 | prune 归档有 TOCTOU 覆盖窗、无逐文件容错，子目录语料与顶层日志不在清扫面 | 开放 | 等样本：TOCTOU 真实冲突实证；子目录策略 Owner 需要时另立 | docs/usage.md |
| TD-128 | 读绑定清扫大部分已修，但维持清单仍有约十处无绑定读面：写侧 CAS 三门、seq 水位族、events[0] 类等，外 run 伪造行仍可污染观测或锁死交付决策 | 开放 | 等样本：触发条件入册（非人调用方、程序化消费输出、pre-envelope 存量变非零） | src/transcript.js src/runManager.js src/backgroundRunner.js |
| TD-133 | delta 认证的空转形状、演练卫生面、存量 worker 重跑三项没处理（Owner 裁定低优先，重跑前要先改剧本）；越界写拦截的证据见决定 0084（codex 车道见 TD-309） | 开放 | 择机：下次车道认证周期 | 0025 0026 |
| TD-134 | runs-guard 只做基线差分不做进程归属，主副本跑 npm test 期间后台 run 落盘即假红 exit 1 | 开放 | 等样本：主副本跑测试期间后台 run 落盘假红再成真实痛点 | scripts/canonical-test.mjs |
| TD-138 | 全量由 filesystem 波决定，慢主要在机器侧：开机越久越慢，11-10（开机 13 天）波长 828–1335 s，11-11 重启后 331–498 s；内存吃紧时起进程变慢，联想 Vantage 一个后台插件单进程吞吐 0.5–5 GB 内存（Owner 已把该服务改为手动）。代码侧：最慢的测试文件每个起 1,200–2,600 个 git 进程；第 105 批合并交付证明里相邻的只读查询，8 个最慢文件少 5.9%。Dev Drive 无效；per-test 上限不动（Owner 11-11） | 开放 | 按 git trace 再定：reclaim 与 isolation 的相邻读取、测试夹具 | scripts/canonical-test.mjs src/delivery.js |
| TD-139 | MCP 的 run_status 只返回 lastActivity.kind，不含活动摘要文本（当初按「安全子集」裁掉）；命令原文已在 run_activity 放开，这条边界该按同一口径重看 | 开放 | 择机：下次改 MCP 状态面时按 run_activity 同一口径放开摘要 |  |
| TD-140 | 运行时硬钉 Node 22 区间，v24 libuv Job Object 回归未修复不能升级，LTS 维护到期即风险 | 开放 | 择机：每季度核对 v24 libuv 修复；2027-01 仍无修复迹象则评估迁移 | src/nodeVersionGuard.js docs/usage.md 0027 |
| TD-141 | 机器护栏只覆盖被断言的面。Owner 裁定：再撞见一次未覆盖面的漂移，就出一份「机器护栏对文档化不变量」的对照清单，逐点决定补断言还是接受 | 开放 | 已命中一次（TD-344：11-08 地图第二轮查出的重复与缺口，守卫没报）：与 TD-344 一起出对照清单 | docs/usage.md scripts/canonical-test.mjs AGENT_ONBOARDING.md |
| TD-143 | 证据链层依赖 runtime 厂商 transcript 访问政策，且治理方法论无第二读者与操作者 | 开放 | 等样本：backend 收紧 transcript 或日志访问、且现有 Backend/parser 保不住证据链时（kimi 2.6/2.7 的接口变化已适配，TD-362）；第二操作者加入前补交接文档 |  |
| TD-149 | repackage 的 allowedPaths 仍硬拒目录/尾斜杠条目，dispatch 收而 repackage 拒；waitWindowHint 缺 MCP 非泄漏钉 | 开放 | 等样本：实际被拒收目录清单时立项；触碰 delivery/repackage 面时顺带 | src/application/runDeliveryRepackage.js docs/02-architecture.md |
| TD-153 | `runs list --since` 不走历史扫描通道；unknown 展示态不能作为过滤条件 | 开放 | 择机：下次改 CLI 查询面时让 --since 走历史扫描通道、放开 unknown 过滤 | src/scorecard.js src/transcript.js docs/usage.md |
| TD-156 | runs/无保留策略，全量扫描随文件数增长变慢，当前约2-4秒逼近阈值 | 开放 | 等样本：全量扫描耗时破 5s 阈值即转按年龄归档（不删除） | scripts/canonical-test.mjs |
| TD-158 | 上游空窗期的派发重试脚本已收编，还没有在真实的空窗连败里用过 | 开放 | 等样本：下次上游空窗连败时启用并评估转正 | scripts/dispatch-with-liveness.mjs |
| TD-160 | 任务书硬化规则部分落地，绑定断言未见记录，措辞过宽仍可触发workdir_escape | 开放 | 择机：触碰任务书模板时补绑定断言、收窄可触发 workdir_escape 的措辞 | SKILL.md docs/usage.md |
| TD-163 | 自然清理时进程仍活或探测抛错的证停告警路径缺自然路径等价测试 | 开放 | 择机：下次触碰 processStopVerify/证停面时补自然路径等价测试 | 0030 |
| TD-164 | 结构化信封试点获 Owner 批准后只跑了首臂，判死条件还没评估（跨模型 KV 直传已裁定不适用） | 开放 | 择机：试点随主线批次；三个重看条件任一满足即重评 |  |
| TD-168 | 测试冗余清扫主体已落地，35 个删并候选仍待人工逐条定谳 | 开放 | 择机：候选逐条定谳；cli.test.js 下次大改时顺带整理 | test/fixtures/mcpWireKeySets.js test/isolation-infra/reporter.test.js |
| TD-169 | 认证通道零 case 已改显式失败（拒跑 exit 2）；selected/executed 等执行计数与 strict drill 覆盖不足可归 full 两项未做 | 开放 | 择机：阶段 2 处理 | scripts/run-reliability.mjs |
| TD-171 | deliveryVerification.test.js 曾在并发下从约 246 秒涨到约 600 秒，原因没查清；2026-10-16/17 的全量里是 207–215 秒，没有复现 | 开放 | 等样本：再复现时查 | test/delivery/deliveryVerification.test.js |
| TD-174 | worker 易把写路径指向主仓根，越界即终态 failed 无挽救；分类提示与诊断标注未落地 | 开放 | 择机：触碰派发任务书或 workdir_escape 提示面时做分类提示与诊断标注 | 0062 |
| TD-176 | 复用断链缺可观测信号：resume 失败后关联链静默回到首轮，排查时看不出（model 接线、中立收紧的文档已了：决定 0046、troubleshooting；auditor 无 verdict 拆到 TD-180，仍开放） | 开放 | 等样本：下一次排查 resume 断链时补可观测信号 | docs/troubleshooting.md |
| TD-178 | live 文档经文档批次改写为现状后，指向运行时状态与 gitignored 路径的 fresh clone 必断指针尚未复扫清点 | 开放 | 择机：下次文档卫生包复扫全部 live 文档的运行时路径引用，无实例即了结 | AGENT_ONBOARDING.md |
| TD-179 | 验证进程未落结果即死的交付没有正式验收出口：等待器在后台形态可证明时已退出（决定 0096），但只能有界拒收后手工采纳；记中断事实、reverify 重跑 pending 形态未做。09-01 至 10-30 共 1 例，为前台 | 开放 | 等样本：后台形态出现，或 Lead 需要正式验收这种交付时 | .wao/decisions/0096-waiter-exits-when-the-verifier-is-gone.md |
| TD-180 | codex 后端启动期退出、零写入零 verdict：用量到顶已能识别（codex 自报的原话进终局 run.error，诊断归 provider_capacity），其余案例原因未明。Owner 已裁定不做自动重试 | 开放 | 等样本：再遇启动期退出样本，先查 codex JSON 输出有无原话 | 0067 docs/troubleshooting.md |
| TD-183 | 完成门只在角色合同探针上（roleProbeRunCompletion）；等待到期与 llm 侧各检查不校验探针 run 是否完成即判定，传输层失败仍可能记成假红 | 开放 | 等样本：provider 抖动打到未覆盖探针时补完成门，或 Owner 裁定推广 | scripts/reliability/componentDrills.mjs src/transcript.js |
| TD-184 | 复用证据已还清；遗留 dsh drill 路由键重算失效待修、codex 转录照不到部分工具调用等小项 | 开放 | 择机：dsh drill 路由键修复待排期；原语表 30 天期限钟持续刷新 | 0045 scripts/reliability/session-reuse-drill.mjs |
| TD-185 | 入口判定修复已落地；测试夹具清理仍留空外层目录、构造失败可能残留 staging，早期 22.x 未实测 | 开放 | 择机：下次修改该夹具时收回清理所有权并覆盖构造失败清理 | test/process/genSurfaceEntry.test.js scripts/gen-surface.mjs |
| TD-186 | 认证证据适用性与取证闭环已修多轮；组件层台账历史死指针、过时注释等残留仍未处理 | 开放 | 择机：触碰组件层台账时清死指针与过时注释；旧画像不明时不得宣称当前已验证 | src/application/registryInventory.js scripts/reliability/prune-drill-transcripts.mjs |
| TD-190 | 各项目的运行记录已按项目分桶，但都放在 WAO 安装根下，能读该根的本机会话仍可跨项目读到任务书与产出；`agent?.cwd` 归属疑点未复核 | 开放 | 等样本：出现需要按项目隔离读取的宿主 | 0060 |
| TD-191 | 宿主接入面仍未全通：三宿主无一条命令注册、派发 advisory 对若干宿主不生效、codex 偶发工具缺失未查 | 开放 | 等样本：各残余自带触发（宿主命令注册、advisory 失效宿主、codex 工具缺失再现） | 0066 0043 |
| TD-193 | kimi-web 后端的 WS 事件流与 seq 游标重放已静态确认但未接线；中止已改走 REST 的 `prompts/{id}:abort` | 开放 | 等样本：REST 轮询的延迟或断线后补读成为实际问题 | docs/incidents/2026-09-30-kimi-web-wiring.md src/backends/kimiWeb.js |
| TD-194 | 全量套件随机无关用例首轮红、单跑绿（isolation_pass）。已知机制：同机两套全量互踩（TD-130，已有验证闸）；回收测试的 fixedNow 重读真实时钟（11-07 修）；`src/cli.js` 被 import 也跑 main（11-10 修）；`cli-runs` P0-1 删临时目录时经 WMI 起的 runner 还在写（11-12 改为等它释放认领再带重试清理）；zcode ⑥b 在 1000ms 真实时限内要满 60 拍（11-12 放宽到 3000ms）。processBackend 一例未归因。波时长见 TD-138 | 开放 | 再遇首轮红按 troubleshooting §8.1 处置，先查用例有无真实时钟窗口 | docs/research/td130-root-cause.md src/verificationGate.js |
| TD-195 | 计划内系统重启会打断交付验证并留下 artifact_mutated 形状；WAO 不改系统设置，错峰靠 Owner 配置 Active Hours | 设计性约束 | 不处理 |  |
| TD-197 | zcode 后端：隐私尽调的观察期未结；隔离通道下评分走的是非隔离目录，待复验 | 开放 | 等样本：出现 ZCode 会话数据上传异常，或隔离评分演练显示实际执行目录与声明工作树不一致时 | 0067 0074 0075 |
| TD-204 | 认证 caseId 仍以 label 为合并键，改名即换键，仅 warn-only 护栏在线未解耦 | 开放 | 择机：下次改认证台账 schema 时解耦 caseId 与 label |  |
| TD-206 | kimiWeb 失败 run 的部分产出不落盘，中途失败后已产出文本不可恢复 | 开放 | 等样本：受督 kimiWeb 长 run 需要中途产出可恢复 |  |
| TD-209 | runner 无声挂死根因与延迟收割者身份未明，复现时需带现场归因；心跳盲区已缓解 | 开放 | 等样本：现行启动路径（决定 0120 的 WMI 启动）下再遇 owner 心跳新鲜、请求或转录长时间无进展时，记下启动方式、计时器、父进程与退出时间 | test/isolation-infra/backgroundRunner.test.js src/backends/kimiWeb.js |
| TD-212 | certification 视图答不到组合验到什么程度，矩阵投影未实现 | 开放 | 择机：下一轮生成器维护窗做矩阵投影 | scripts/gen-certification.mjs |
| TD-216 | 判定失败是否新引入仍需自建基线对照，一键差分工具未落地 | 开放 | 等样本：现行夹具下隔离复跑仍失败、须在相同环境对照父提交才能判断是否本改动引入时（夹具权威化已了：TD-214、TD-242） |  |
| TD-219 | acceptance 落盘已落地，但仓库外写入任务走不了交付管线，expectedWriteRoots 与 manifest 第二步未落地 | 开放 | 等样本：仓库外写入任务族再临 |  |
| TD-220 | 投影与标签已修，但 shell 介导写入不产事件且无写根比对锚，读侧新鲜度与事件时间戳失真仍挂账 | 开放 | 等样本：监督中出现磁盘变更无对应事件、非交付运行缺写根无法比对，或落盘时间偏差影响判断时（写根比对锚随 TD-219） |  |
| TD-225 | workspace 绑定强制 git 仓库，非 git 任务需现造锚点仓库并事后清扫 | 设计性约束 | 需要时现造锚点仓库，任务完成后顺手清扫现场 |  |
| TD-231 | repackage 的 validateInput 严校验、CAS 形状不变量、commit 失败、Git 异常等拒绝路径仍为裸意外错误 | 开放 | 择机：触碰 repackage 时把拒绝路径从裸意外错误改为闭集拒绝 |  |
| TD-241 | 成功面 text 仍与 structuredContent 双份全量 JSON（C1 挂起），kimi/opencode/zcode 三宿主消费行为未探 | 开放 | 等样本：C3 实测截断，或未探宿主证据显示成功面 text 被消费 | 0051 |
| TD-244 | 前台 isolation 失败时转录首事件缺 project 事实，被判 unattributed 且迁移闭集缺该类型 | 开放 | 择机：随下次触碰前台 isolation 失败路径修（触发面低频） | src/runManager.js |
| TD-245 | 运行认领文件永不删除、每次仲裁全量列目录；四个需要持续 IO 故障才触发的理论窗口已接受 | 设计性约束 | 认领目录列举成为瓶颈，或真实撞到并发认领 |  |
| TD-248 | interference 登记册的交付保留路径仍靠派发纪律保护，机器化未落地 | 开放 | 择机：触碰派发纪律面时把交付保留路径机器化 | 0054 |
| TD-250 | kimi 上游不回收会话进程荚；serve 整体空闲退出（0079）后荚随 serve 拆除、基本不再堆积；failed 会话的清扫判据没做 | 开放 | 等样本：failed 会话堆积再现时做清扫判据 | 0056 |
| TD-254 | readOnly×lead_workspace 错位：kimi 服务端会话的 cwd 钉在首轮树，复用轮可能另建树（resume 跑回源仓的缺口已由决定 0063、eaed753e 修） | 开放 | 等样本：同一 Lead 与项目第二次只读复用 kimi 会话时，实际操作目录仍是首轮树、而转录与观察面绑定了另一棵树 | 0058 |
| TD-260 | 若干收口项（红队补记、supersedes lineage 事实、交付收条等）登记未实施 | 开放 | 择机：Owner 点名后实施各收口项 | 0062 |
| TD-266 | worker 会读宿主仓库的规则与概况文件，连同任务需要读的内容一起发给车道背后的模型方 | 设计性约束 | Owner 2026-10-15 裁定：用户自己选了车道，就是同意把项目内容发给对应的模型方，要保密可以改用本地模型；WAO 不做读取范围声明，也不做按项目的车道白名单 | AGENTS.md |
| TD-270 | deepseek 两后端仍无静默期取样（processActivity 只接 processBackend/zcode）；0072 起命令在跑已对 Lead 可见 | 开放 | 择机：下次改动 deepseek 后端时接静默取样 | 0070 0072 |
| TD-271 | 评分与 run_activity 的退出码推断仍是两套实现；0073 起两道门效果已一致，仅未并轨 | 开放 | 择机：下次改评分或活动投影时并成一个判据 | 0072 0073 |
| TD-274 | kimi 车道出现过上游 `Request timed out`（发生时只有一个任务在跑），原因未查明 | 开放 | 等样本：上游 Request timed out 再现时带现场归因 | 0073 0074 |
| TD-280 | zcode / kimi-web 的严格评分演练以 failed 收尾（认证判定仍是不适用），认证演练没有重跑 | 开放 | 择机：下次例行认证时重跑 | 0072 |
| TD-281 | requireCommands×无退出码后端：registry validate 已有警告（0072），派发时刻仍无提示 | 开放 | 择机：下次改派发前检查时把警告接到派发面 | 0072 |
| TD-304 | 终态额度正则的一个分支会把 "tokens per min limit reached" 这类措辞归成 `quota_exhausted`，而分钟级限流会自愈、恢复方式不同；这句是构造的措辞，OpenAI 实际的 TPM 报错归 `rate_limited`，尚无真实误归样本 | 开放 | 等样本：真实误归样本出现时按窗口长短区分限流与额度耗尽 | src/diagnosis.js |
| TD-308 | 不写 profile 或 basic 画像的矩阵行，drills 不含相应活体检查（containmentEvidence，或声明 OS 沙箱车道的 sandboxEnforcement）时仍可评 certified、scope 记 full，没有任何越界写拦截的活体证据（strict 与 certification 已在矩阵构建时补齐） | 开放 | 择机：认证判定要求相应活体检查（containmentEvidence，或声明 OS 沙箱车道的 sandboxEnforcement）在场才可评 certified，或矩阵解析对这类行给出提示 | 0084 0086 scripts/reliability/certification.mjs |
| TD-310 | 带 sessionReuse 的只读运行仍用 persistent 链接工作树：席位在树里跑 `git config`、`git branch`、`git worktree add`，写的仍是共享仓，运行事实里没有记录（ephemeral 只读运行已改用私有克隆，决定 0102）；只读观察只认 file_written，shell 写入看不见 | 开放 | 择机：下次动 sessionReuse 只读运行时评估同样改用私有克隆（kimi 会话的 server 侧 cwd 钉在首轮树，克隆要与线系同寿） | 0102 0057 src/runManager.js |
| TD-321 | codex 车道没有在途纠偏：WAO 走 `codex exec`，exec 活动轮不消费 `codex queue` 排队的消息（0.165.0 复测仍阴性）；上游 app-server 协议已有 `turn/steer` 与 `turn/interrupt`。Owner 2026-10-29 裁定 codex 车道只做会审 | 设计性约束 | 车道职责变化、需要在途纠偏时：codex 后端改走 app-server 通道并补 live 实测 | src/backends/codex.js docs/certification-runbook.md |
| TD-323 | codex 沙箱里的会审席找不到 Node 22：scripts/wao-node.cjs 只看 WAO_NODE、%LOCALAPPDATA% 约定路径与 PATH，沙箱用户三样都对不上（PATH 只有 Node 24），席位跑 `npm test` 或 CLI 时任务书得写死 node-v22 的绝对路径 | 开放 | 择机：下次改 codex 后端或启动器时，让席位环境拿得到 WAO 自己所用的 Node 路径 | scripts/wao-node.cjs src/backends/codex.js |
| TD-326 | 没删掉的私有克隆只保留、不自动回收：停止未确认、有新提交、HEAD 漂移、嵌套工作树、检查失败、删除失败或 spawn 后才被拒时留在 `.wao-worktrees/<runId>`；回收计划把转录可读且绑定此目录的归 `tree_protection`/`private_clone`，其余按外来或无法判定保留，人工处置见维护页；保留的克隆借源仓对象，源仓维护可能清掉这些对象 | 开放 | 等样本：残留克隆真积累起来时，给回收计划加 remove_clone 动作（apply 重证归属、收口、无新提交、无嵌套工作树），要留证据的先打包 | 0102 src/application/worktreeReclaim.js src/isolation.js |
| TD-330 | zcode 的 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 两边口径不一：doctor 与承重声明表把它当承重变量检查，进程继承名单只放行 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`，registry 不写 env 块时它到不了 worker。2026-11-02 实测个人配置在默认位置时 canary 仍通过；放在别处时会丢 | 开放 | 下次动 zcode 车道或承重 env 时 | src/envPolicy.js src/application/loadBearingEnv.js |
| TD-331 | `test/migration-0045/` 的 14 个测试文件是决定 0045 迁移批留下的，从没逐个审过：有的守着现行的角色、派发与身份合同，有的测一次性迁移工具（如 `ledgerMigration.test.js` 测 `scripts/migration/migrate-cert-ledger.mjs`） | 开放 | 有批次改到这些测试覆盖的派发、角色或身份代码时逐个审：守现行合同的留下，只测已不再用的一次性迁移的，连同那个工具一起退役 | test/migration-0045 scripts/migration |
| TD-334 | 复用运行的 native 会话 id（codex `thread.started`）只在正常收口时写下，运行被停止时不写。读侧对紧邻前一轮读不出的情况记未知，用量不说假话；代价是停止轮之后那一轮的自身用量未知，停止的 codex 子运行也续不了（`no_provider_session`） | 开放 | 择机：在运行期观察到 id 的那一刻落盘 `run.provider_session_bound`（`session.created` 保持唯一 `proc_<pid>`），所有停止路径随之覆盖 | 0114 src/runManager.js |
| TD-340 | `runs wait` 与 `consult wait` 的 `--until-settled` 对 `runs settle` 门以正面证据拒绝的运行（带 serve 停止路由、有活 daemon）一直等；未知类拒绝自第 107 批起静默满 30 分钟报警退出 | 开放 | 等样本：这类运行真出现要人工脱困的长等时，记干跑拒绝码、体征与等待时长 | src/application/runSettlementWait.js |
| TD-344 | 2026-11-08 地图第二轮查出、发版前未改的重复与缺口：权威边界句五处逐字（守卫 M12-0-01 强制）；claude-code 隔离配置目录四处；zcode env 桥三处；transcript 路径在 README 与 architecture；host.md 复述 npm run mcp；认证门禁与模型/runtime 分叉的操作细节；lane-traits 注释复述政策；`wao accept` 无手册节 | 开放 | 择机：先连测试里钉住的字面一起查全，再定家收指针 | docs/ssot.md |
| TD-349 | 定向测试并发跑时偶发 1 条失败：第 90 批本地 `cli-runs.test.js` 的 `run --format json: --scorecard-rules-file` 读到的不是 JSON；第 92 批交付验证同组命令 1/334 失败（只留尾部，认不出是哪条），reverify 通过 | 开放 | 等样本：再遇到时抓完整输出定位用例 | test/isolation-infra/cli-runs.test.js |
| TD-350 | 第 93 批首次 WMI 路径冒烟（2026-11-09）：一个后台派发的 runner 起来后第 9 秒仍活着却没写任何事件，5 分钟内消失，没留 `.runner-<runId>.stderr`，事件日志无崩溃；之后同样的命令 6 次全过，会审从代码排除了 stdin 等不到 EOF | 开放 | 再出现时：第 9 秒看 `.owner-<runId>` 有没有、是否新鲜（判它卡在读提示词前还是建工作树），记下 runner 的父进程与命令行、stderr 文件是否存在 | src/runnerBroker.js src/backgroundRunner.js |
| TD-354 | 失败来源分不清：没有按宿主/WAO/服务商/额度分开的各车道失败率，运行时版本也不与最近认证的版本比对（ZCode 3.18、kimi 2.6 那类接口变化要靠人巡检发现）；kimi-web 的 `provider.api_error` 已在第 124 批认出（诊断 `provider_disconnect`、活动页 `kind: error`） | 开放 | 其它后端的服务商错误有真实样本时照第 124 批补认；版本指纹比对与分来源失败率等再遇一次接口变化事故再做 | src/diagnosis.js src/application/runActivityProjection.js |
| TD-355 | Owner 看板不是给人看的（11-19 Owner 试用）：标题是 runId、满是行话、全英文、无主次无总览，不显示任务、交付、裁决与失败原因；命令只显示“exit unknown”不显示内容（接口里有），文件路径一律 withheld，心跳占一半行，最新在底且每 2 秒整块重画；计数是最近一拍的增量；开发工作树的运行在主项目看板上看不到，每个项目各起一个看板、App 重启即停；历史首载 24h 约 35 秒；无深色模式；App 内置浏览器里通知被拒 | 开放 | Owner 定回头专题处理（先出设计稿再改） | src/owner-dashboard/app.js src/application/ownerDashboard.js |
| TD-356 | 选车道规则在派发时看不到（carloha_fde 11-19 反馈）：glm-pro 连续 429 后，Lead 照 `lead_preflight` workers（不显示成本档、星级、Owner 规则）把实现派给 astra、kimi，跳过 deepseek-flash；`runs diagnose` 报 `provider_capacity` 不说下一条车道 | 开放 | 11-25 车道分布复查时定：workers 行指向 lead_preflight 车道表，诊断按 ownerRules 点名下一条车道；规则 3 补“限流”（Owner 11-19 已定） | src/application/laneFactsLine.js src/diagnosis.js config/lane-traits.json |
| TD-358 | 回收两处保守边界（b120 sol 复核）：~~执行门不查计划的 15 分钟近期事件保护（实测删了一个已终态、重新打包被拒的运行的 ref）~~（第 133 批闭环这一半：执行门的树路径与只剩分支路径都与计划共用同一近期活动与收口判定，sol 会审后含补验证排队形态）；存储读不全时，唯一的桶 stat 失败或唯一转录在读不出的归档月份会报“转录库为空”，桶 readdir 失败直接抛错，看不到全保留计划 | 开放 | 再遇回收误判或故障期间要看计划时：这几种故障也出全保留计划 | 0126 src/application/worktreeReclaim.js |
| TD-360 | 诊断的两条老口径（第 124 批 sol 会审）："最后一条 `run.error`"实际取最后一条带字符串 `error` 的，其后只有结构化字段的 `run.error` 会被跳过；旧 auth/config 规则匹配到报文里的偶然 `401`、`precedence` 时，CLI `runs diagnose` 的证据回显报文原文与 turn id（MCP 只投影闭集，不回显） | 开放 | 再遇误判或要收紧 CLI 证据时处理：取最后一条绑定 `run.error` 不论字段形状；auth/config 只认状态码字段或锚定句式，CLI 证据改固定事实 | src/diagnosis.js src/commands/runs.js |
| TD-361 | 只发 `file_written`、不发 `write_intent` 的车道（kimi、zcode、codex）写了又删仍判越界：第 148 批的放宽只给同一调用、同一原文路径、意图时刻已判树内、无 `..` 段且每段是规范 Win32 段的写入（TD-372 已了结），这几条车道没有意图可依。按分类时刻的磁盘放宽是检查与使用的竞态，第 126 批两版都被真实 junction 打穿 | 开放 | 再遇此类误判时：让该车道在 tool_use 时发带 toolCallId 的 `write_intent` | src/runManager.js src/backends/kimiWeb.js |
| TD-363 | kimi worker 停在提问或审批上时（`AskUserQuestion`，2.4.0 起就有；2.7 的会话详情 `pending_interaction` 不为 `none`，在途工具调用带 `interaction_id`），WAO 等不来回答，要到停滞门或 30 分钟活体硬顶才收口，报的是停滞 | 开放 | 触发：第一次实际遇到（2026-11-21 普查本机 369 次 kimi 运行，零次调用该工具、零次停在审批上）。做法：轮里见到带 `interaction_id` 的在途工具调用就读 `GET …/interactions`，以"worker 在等回答"失败收口并带上问题原文，Lead 用 `run_continue` 带答案续修 | src/backends/kimiWeb.js src/diagnosis.js |
| TD-366 | nextStep 模板超 480 字符时抛错，调用面把它当失败：CLI `runs wait --until-settled` 收口时 runId 长于 77 字符（可续交付，第 136 批复核实测）就退出 1、丢掉收口结果，多目标等待连带丢掉其余目标的输出；有界等待、`consult show` 与 runner/verifier 出口模板同类。WAO 生成的 id 只有 27 字符 | 开放 | 触发：真实 id 变长，或一次实际触发。做法：调用面接住模板超长，退回不带 id 的短句，不丢其余输出 | src/application/runNextStep.js src/commands/runs.js |
| TD-367 | MCP `run_delivery_repackage` / `run_delivery_reverify` 的验证仍跑在 MCP 服务进程里，宿主单次调用超时重启服务时验证被杀；137a 起超窗回执指向 CLI 后台跑。做成脱离作业要作业登记与认领、带作业身份的结果文件、reverify 补 owner 租约与 `reverify_pending` 缺席证明、启动清理按作业 id、45 秒总预算（第 137 批方案会审 kimi、sol） | 开放 | 触发：只有 MCP 的宿主真遇到验证被杀。做法：经 0120 的启动模块起薄的交付作业入口，调用同一应用层服务 | src/mcp/server.js src/application/runDeliveryRepackage.js src/application/runDeliveryReverify.js |
| TD-368 | daemon（`daemon start/run/supervise/ping/list/status`）去留未定：10 月以来本机 Lead 零调用；它有 IPC 停止、`resume-on-start` 接管与 supervisor 重启，0120 的脱离 runner 不提供这些；可靠性演练与 `runs settle` 的缺席证明依赖它的握手（第 137 批方案会审：kimi 主张退役，sol 主张保留） | 开放 | 触发：下一次 MINOR 发版前复审。退役前提：演练改为脱离 runner 加 `wao stop` 且断言不减、旧 daemon 排干、结算证明去掉 daemon 门 | src/daemon.js src/daemonSupervisor.js src/commands/daemon.js src/application/runSettle.js |
| TD-370 | 可靠性门脚本不能并发，整表跑也不认暂停派发：所有实例共用 `scripts/reliability-tmp` 并在结束时整个删掉，认证台账的发布是不加锁的读改写；不带 `--agent` 时会去探测挂着暂停的车道。两个会话同时跑（巡检与发版）也会撞上 | 开放 | 下一次改可靠性门时：每个实例独立临时目录、发布加锁、整表默认跳过暂停车道并列出，再考虑按服务商分组并发 2–3 | scripts/run-reliability.mjs |
| TD-371 | 会审席位不能续接自己上一轮的会话：续接只认带交付的运行（父运行没有交付时拒为 `no_delivery`），多轮讨论只能重开一场，靠附上一轮答复接上下文（Owner 11-24：独立性有道理，灵活性不足）。独立性要的是席位之间互相看不到，一席续接自己的会话并不破坏它 | 开放 | 下一次改会审或续修时：允许只读运行续接自己的会话（同席、同车道），席位之间仍互不可见 | src/application/runContinue.js |
| TD-374 | `worktree reclaim --apply` 删已裁决或谱系已关运行的脏树时用 `git worktree remove --force`，只落一份 `status --porcelain` 路径清单，受控改动与未忽略的新文件内容不留（宿主 carloha_fde 11-25 一次清退里 54 棵，事后核对都是被忽略文件，没有实际损失） | 开放 | 下次改回收时：有受控改动或未忽略新文件的树，先把 diff 与这些文件的副本存进本次回收记录再删；只有被忽略文件的照旧直接删 | src/application/worktreeReclaim.js |
| TD-375 | "头指针漂移"两处口径不一：`runs lineage-close` 比树 HEAD 与交付提交（或基点提交），`worktree reclaim` 比树 HEAD 与该运行分支的 tip——lineage-close 判漂移留下的树，reclaim 认为可回收（宿主 carloha_fde 11-25 的审查席树） | 开放 | 与 TD-374 同批：统一成一个判定；分支照旧进 bundle，HEAD 在自己分支 tip 上就不丢提交 | src/application/lineageClose.js src/application/worktreeReclaim.js |
| TD-376 | kimi 车道（2.7.2）一个会审席的最终回答在句中截断：consult_20261125065231263k9dx78 的 kimi 席最后一条消息 1,576 字符、停在第 3 条中途，运行照常 completed，转录没有停止原因；最后一条 `streaming` 活动距完成 5 秒，分不清是模型输出上限还是 WAO 在消息流完前就判了回合结束（同版本 11-24 一席答了 11KB，完整）。一例 | 开放 | 再遇到时先别删上游会话，用 `GET …/agents/main/turns` 对照全文再判 | src/backends/kimiWeb.js |
| TD-377 | settle 与续跑之间有并发窗口：门 3 只扫描一次，续跑先起进程后追加 `run.rerun`，`--apply` 只核对 `expectedLastSeq`，落在两步之间的结算会把已活的 runner 判终态（第 148 批 sol 会审按代码时序推断，未实测；第 148 批让门 5 放行更多旧会话） | 开放 | 再动 settle 或续跑启动时：两者经同一 runId 的互斥仲裁 | src/application/runSettle.js src/runManager.js |
| TD-378 | deepseek-acp 后端在入队前就把整条写事件脱敏，隔离判定拿到的路径与 toolCallId 可能已被改写（第 148 批 sol 会审）；第 148 批只让带脱敏标记的路径不享受 TD-372 的放宽 | 开放 | 再动 deepseek-acp 的事件边界时：隔离门用原文判定，落盘时再脱敏 | src/backends/deepSeekAcp.js |
| TD-379 | runner 确已被杀时 `wao status` 的 runner 不在证明没成立：2026-11-25 sonnet 横评 C1（worker 按 runId 杀进程连带杀掉 runner），21:06 只给普通静默提示并建议 `wao stop`，21:07 `runs settle` 干跑六道门全过；原因未复现，可能是扫描把读不到命令行的 node 进程算成可能的 runner，或扫描超时。第 149 批起心跳已停即改指 settle 干跑兜底 | 开放 | 等样本：再遇到时立刻跑 `runs settle` 干跑，并留下扫描输出 | src/application/runnerGoneProof.js src/application/runSettle.js |
