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
| TD-15 | ProcessBackend 的 retries 参数被忽略；自动重试已裁定不做，这个参数是候选删除项 | 开放 | 择机：下次改动进程式后端的派发参数时删除 |  |
| TD-16 | 真实 CLI smoke 依赖真实 API、登录与费用，刻意不进 npm test、CI 不跑 | 设计性约束 | 涉及外部系统的 milestone 收尾必跑 smoke | docs/milestone-discipline.md |
| TD-29 | 大 DAG 的 completedResults Map 占用内存，无流式或分页机制 | 开放 | 等样本：实际遇到大 DAG 内存压力 |  |
| TD-31 | workflow 脚本具备完全 JS 能力，风险与 npm script 同级，属刻意接受 | 设计性约束 | 文档标注即可，无需代码修复 |  |
| TD-34 | 文档守卫有两类遗留：一批测试只钉历史收尾文字（某文档必须出现某句话），被钉的文字因此删不掉、挪不动；使用手册的检查读地图加全部页的拼接，不知道自己保护的是哪一页 | 开放 | 下一批：按清单逐条退役钉历史的断言并写明接续保护；手册检查改为只读它保护的那一页 | 0076 test/isolation-infra/docs-consistency.test.js |
| TD-41 | abort 测试在全量高负载下偶发失败，缺确定性的子进程退出因果判定 | 开放 | 等样本：再次稳定复现时改用 child exit 事件建立因果 |  |
| TD-45 | daemon 自愈已落地，但 supervisor 自身被杀后无法自动重启 | 开放 | 择机：supervisor 重生引导（Windows 服务/计划任务）留 v2 | src/daemonSupervisor.js |
| TD-46 | daemon 长跑累积子进程残留与句柄泄漏的根因未修，仅监控告警就位 | 开放 | 等样本：health warn 实际触发后针对性修 |  |
| TD-47 | daemon IPC 仅请求-响应，tail 依赖文件轮询，无流式推送 | 开放 | 等样本：真实流式需求出现（SSE 式推送或保留文件轮询） |  |
| TD-50 | 失败分类是启发式信号匹配，边缘 case 降级 unknown，刻意只给证据不给处方 | 设计性约束 | 新增 provider 错误格式时扩充 AUTH_SIGNAL 即可 | src/diagnosis.js |
| TD-84 | 目标项目未 init 时 `wao declare` / `wao stage` 以 ENOENT 崩溃 | 开放 | 等样本：跨项目派工再次撞到 | src/cli.js |
| TD-96 | `wao stage` 每个阶段要手拼 task、artifacts、cwd；按 run 自动填充（`--from-run`）登记了没做 | 开放 | 等样本：真实使用里再次需要自动填充 |  |
| TD-97 | scorecard 的 requireCommands/requireFiles 证据判定独立于统一评估模块 | 设计性约束 | 刻意边界：核心证据事实已统一于 runEvidenceAssessment，requireCommands/requireFiles 因需 I/O 与复杂匹配留在 scorecard；两套判据漂移实证再重开 | src/runEvidenceAssessment.js |
| TD-104 | 同一 OS identity 下 worker 仍可读取分配的凭据文件，credential broker 未落地 | 开放 | 择机：无人值守、多租户或强隔离发布前做 credential broker 或独立身份 | 0016 docs/incidents/2026-07-12-worker-credential-exposure.md |
| TD-106 | Tester 上下文效率属 Codex 产品与订阅配额问题，WAO 刻意不吸收该职责 | 设计性约束 | 未定 |  |
| TD-108 | evidence fallback 调用未按 expectedRunId 过滤，跨 run 证据污染仍是理论风险 | 开放 | 等样本：跨 run 证据污染实证，或需接受混合历史 transcript |  |
| TD-115 | lastHealthyRunAt 非 sticky，重跑失败后新鲜度归空，失败场景拿不到上次健康时间 | 开放 | 等样本：Lead 实际需要失败场景的历史新鲜度 |  |
| TD-117 | kimi-code 与 deepseek-harness 两个后端能力不全（不上报用量、不支持会话复用等），暂停使用、不配车道 | 开放 | 等样本：巡检确认能力补足且明显优于 kimi-web / deepseek-acp | 0074 src/backends/deepSeekHarness.js |
| TD-118 | 技能安装是指向仓库根的 junction，改动写盘即生效于所有会话，无提交闸门 | 设计性约束 | fresh clone 后需重新安装 | SKILL.md |
| TD-123 | 全行扫描正则对注释/字符串有假阳性面，application 的 bare 包出边未入方向矩阵 | 开放 | 等样本：首次全行扫描假红实证；触碰 layering 矩阵时顺带补 bare 包出边 |  |
| TD-124 | 静态规则可被单行 join 逃逸、白名单非行内容锚定、深度2写者未覆盖 | 开放 | 等样本：首次真实逃逸实证；触碰守卫/白名单时顺带收紧 | src/application/sessionReuse.js |
| TD-125 | prune 归档有 TOCTOU 覆盖窗、无逐文件容错，子目录语料与顶层日志不在清扫面 | 开放 | 等样本：TOCTOU 真实冲突实证；子目录策略 Owner 需要时另立 | docs/usage.md |
| TD-128 | 读绑定清扫大部分已修，但维持清单仍有约十处无绑定读面：写侧 CAS 三门、seq 水位族、events[0] 类等，外 run 伪造行仍可污染观测或锁死交付决策 | 开放 | 等样本：触发条件入册（非人调用方、程序化消费输出、pre-envelope 存量变非零） | src/transcript.js src/runManager.js src/backgroundRunner.js |
| TD-130 | 全量测试套件存在多文件多波环境性 isolation_pass 假失败，根因未定位，靠串行闸与复跑缓解 | 开放 | 等样本：T1/T2/T3 重开后闸独占下仍现 isolation_pass 假失败 | docs/research/td130-root-cause.md src/verificationGate.js src/machineGatePaths.js |
| TD-133 | delta 认证的空转形状、演练卫生面、存量 worker 重跑三项没处理（Owner 裁定低优先，重跑前要先改剧本）；越界写拦截链的实测归 TD-196 | 开放 | 择机：下次车道认证周期 | 0025 0026 |
| TD-134 | runs-guard 只做基线差分不做进程归属，主副本跑 npm test 期间后台 run 落盘即假红 exit 1 | 开放 | 等样本：主副本跑测试期间后台 run 落盘假红再成真实痛点 | scripts/canonical-test.mjs |
| TD-135 | 并行会话集成后的语义组合冲突无机制覆盖，集成终验依赖 Lead 手动执行且时机不保证 | 开放 | 等样本：语义组合冲突致集成后回归实证；并行成常态时终验加为必做步骤 |  |
| TD-138 | 全量测试约 9 分钟（2026-10-15 实测 551 秒），由 filesystem 波决定（326 秒，82 个文件并发 8），这一波在等几个交付类测试文件 | 开放 | 下一批：按 `test-results.json` 的 `durationMs` 找出最慢文件，用共用夹具或注入缝压时间 | docs/testing.md test/manifest.json |
| TD-139 | MCP 的 run_status 只返回 lastActivity.kind，不含活动摘要文本（当初按「安全子集」裁掉）；命令原文已在 run_activity 放开，这条边界该按同一口径重看 | 开放 | 择机：下次改 MCP 状态面时按 run_activity 同一口径放开摘要 |  |
| TD-140 | 运行时硬钉 Node 22 区间，v24 libuv Job Object 回归未修复不能升级，LTS 维护到期即风险 | 开放 | 择机：每季度核对 v24 libuv 修复；2027-01 仍无修复迹象则评估迁移 | src/nodeVersionGuard.js docs/usage.md 0027 |
| TD-141 | 机器护栏只覆盖被断言的面。Owner 裁定：再撞见一次未覆盖面的漂移，就出一份「机器护栏对文档化不变量」的对照清单，逐点决定补断言还是接受 | 开放 | 等样本：再撞见一次未覆盖面的漂移即出对照清单 | docs/usage.md scripts/canonical-test.mjs AGENT_ONBOARDING.md |
| TD-142 | workflow / DAG 层利用率低，裁定保留现状不退役 | 设计性约束 | 连续一个季度零 workflow 运行，或该层需要实质改动 | 0027 |
| TD-143 | 证据链层依赖 runtime 厂商 transcript 访问政策，且治理方法论无第二读者与操作者 | 开放 | 等样本：backend 收紧 transcript 政策，或第二操作者加入前补交接文档 |  |
| TD-146 | 非交付运行与未打包的交付运行，终态后即使树干净、没有新提交也不回收；`wao worktree reclaim` 已落地（含嵌套运行树），存量按 Owner 批准计划清退，新的累积仍在发生 | 开放 | 下一批：终态零丢失自动回收（0057 W1a、0060 条款已会审，0082 已批）任务书定稿 | 0082 |
| TD-149 | repackage 的 allowedPaths 仍硬拒目录/尾斜杠条目，dispatch 收而 repackage 拒；waitWindowHint 缺 MCP 非泄漏钉 | 开放 | 等样本：实际被拒收目录清单时立项；触碰 delivery/repackage 面时顺带 | src/application/runDeliveryRepackage.js docs/02-architecture.md |
| TD-153 | `runs list --since` 不走历史扫描通道；unknown 展示态不能作为过滤条件 | 开放 | 择机：下次改 CLI 查询面时让 --since 走历史扫描通道、放开 unknown 过滤 | src/scorecard.js src/transcript.js docs/usage.md |
| TD-156 | runs/无保留策略，全量扫描随文件数增长变慢，当前约2-4秒逼近阈值 | 开放 | 等样本：全量扫描耗时破 5s 阈值即转按年龄归档（不删除） | scripts/canonical-test.mjs |
| TD-158 | 上游空窗期的派发重试脚本已收编，还没有在真实的空窗连败里用过 | 开放 | 等样本：下次上游空窗连败时启用并评估转正 | scripts/dispatch-with-liveness.mjs |
| TD-160 | 任务书硬化规则部分落地，绑定断言未见记录，措辞过宽仍可触发workdir_escape | 开放 | 择机：触碰任务书模板时补绑定断言、收窄可触发 workdir_escape 的措辞 | SKILL.md docs/usage.md |
| TD-163 | 自然清理时进程仍活或探测抛错的证停告警路径缺自然路径等价测试 | 开放 | 择机：下次触碰 processStopVerify/证停面时补自然路径等价测试 | 0030 |
| TD-164 | 结构化信封试点获 Owner 批准后只跑了首臂，判死条件还没评估（跨模型 KV 直传已裁定不适用） | 开放 | 择机：试点随主线批次；三个重看条件任一满足即重评 |  |
| TD-168 | 测试冗余清扫主体已落地，35 个删并候选仍待人工逐条定谳 | 开放 | 择机：候选逐条定谳；cli.test.js 下次大改时顺带整理 | test/fixtures/mcpWireKeySets.js test/isolation-infra/reporter.test.js |
| TD-169 | 认证通道零 case 已改显式失败（拒跑 exit 2）；selected/executed 等执行计数与 strict drill 覆盖不足可归 full 两项未做 | 开放 | 择机：阶段 2 处理 | scripts/run-reliability.mjs |
| TD-170 | 全量测试各波的时长没有基线和漂移告警（上次靠人工比对才发现 390s 涨到 600s） | 开放 | 等样本：环境漂移再次污染验证结论时建波时长基线与告警 |  |
| TD-171 | 环境性验证失败会烧掉仅有的一次 reverify 机会；deliveryVerification.test.js 单文件已提速（0d306e6），并发下约 246s→600s 的膨胀原因没查清 | 等待裁定 | Owner 定：环境性失败是否给第二次重验机会；膨胀原因下次复现时查 | test/delivery/deliveryVerification.test.js |
| TD-174 | worker 易把写路径指向主仓根，越界即终态 failed 无挽救；分类提示与诊断标注未落地 | 开放 | 择机：触碰派发任务书或 workdir_escape 提示面时做分类提示与诊断标注 | 0062 |
| TD-176 | 缺 model 接线设计入口、中立收紧缺文档可见性、auditor 无 verdict 缺失败归类、复用断链缺可观测信号 | 开放 | 等样本：四项独立触发（接线 model、改文档、auditor 无 verdict、排查断链） | docs/troubleshooting.md |
| TD-178 | live 文档经文档批次改写为现状后，指向运行时状态与 gitignored 路径的 fresh clone 必断指针尚未复扫清点 | 开放 | 择机：下次文档卫生包复扫全部 live 文档的运行时路径引用，无实例即了结 | AGENT_ONBOARDING.md |
| TD-179 | 验证进程未落 outcome 即死的自动识别（verification_interrupted 事实）与经 reverify 重跑 pending 形态仍未实现 | 开放 | 择机：触碰交付验证恢复面时做 verification_interrupted 识别与 pending 形态 reverify | docs/02-architecture.md |
| TD-180 | codex 后端启动期退出、零写入零 verdict：用量到顶已能识别（codex 自报的原话进终局 run.error，诊断归 provider_capacity），其余案例原因未明。Owner 已裁定不做自动重试 | 开放 | 等样本：再遇启动期退出样本，先查 codex JSON 输出有无原话 | 0067 docs/troubleshooting.md |
| TD-181 | 全量测试跨波间歇性失败（波内红、单跑绿、同提交复跑即绿）仍未归因 | 开放 | 等样本：跨波失败再现时按 testing.md §8.1 安静窗口单发复验收敛归因 |  |
| TD-182 | 会话恢复证据的历史来源不可独立复核，重跑 drill 前不得声称已独立验证 | 开放 | 等样本：下一次真实恢复 drill 运行 |  |
| TD-183 | 完成门只在角色合同探针上（roleProbeRunCompletion）；等待到期与 llm 侧各检查不校验探针 run 是否完成即判定，传输层失败仍可能记成假红 | 开放 | 等样本：provider 抖动打到未覆盖探针时补完成门，或 Owner 裁定推广 | scripts/reliability/componentDrills.mjs src/transcript.js |
| TD-184 | 复用证据已还清；遗留 dsh drill 路由键重算失效待修、codex 转录照不到部分工具调用等小项 | 开放 | 择机：dsh drill 路由键修复待排期；原语表 30 天期限钟持续刷新 | 0045 scripts/reliability/session-reuse-drill.mjs |
| TD-185 | 入口判定修复已落地；测试夹具清理仍留空外层目录、构造失败可能残留 staging，早期 22.x 未实测 | 开放 | 择机：下次修改该夹具时收回清理所有权并覆盖构造失败清理 | test/process/genSurfaceEntry.test.js scripts/gen-surface.mjs |
| TD-186 | 认证证据适用性与取证闭环已修多轮；组件层台账历史死指针、过时注释等残留仍未处理 | 开放 | 择机：触碰组件层台账时清死指针与过时注释；旧画像不明时不得宣称当前已验证 | src/application/registryInventory.js scripts/reliability/prune-drill-transcripts.mjs |
| TD-190 | 各项目的运行记录已按项目分桶，但都放在 WAO 安装根下，能读该根的本机会话仍可跨项目读到任务书与产出；`agent?.cwd` 归属疑点未复核 | 开放 | 等样本：出现需要按项目隔离读取的宿主 | 0060 |
| TD-191 | 宿主接入面仍未全通：三宿主无一条命令注册、派发 advisory 对若干宿主不生效、codex 偶发工具缺失未查 | 开放 | 等样本：各残余自带触发（宿主命令注册、advisory 失效宿主、codex 工具缺失再现） | 0066 0043 |
| TD-193 | kimi-web 后端的 WS 事件流、seq 游标重放与按提示中止能力已静态确认但未接线，REST 通道无会话级中止 | 开放 | 等样本：kimi-web 席位转正或会话级中止需求出现 | docs/incidents/2026-09-30-kimi-web-wiring.md |
| TD-194 | 白天并发跑全量测试套件时随机无关用例抖动（isolation_pass 或空 tail 失败），根因未定，worktree 数量相关性未排除 | 开放 | 等样本：白天 flake 再现时逐案直跑复现加机器态取证，累计 3 例立专案 |  |
| TD-195 | 计划内系统重启会打断交付验证并留下 artifact_mutated 形状；WAO 不改系统设置，错峰靠 Owner 配置 Active Hours | 设计性约束 | 不处理 |  |
| TD-196 | 对抗逃逸演练依赖模型配合，守约模型即无靶；拦截链端到端仅有单测未实测，例外席被全量认证机械降级需脚本手工恢复 | 开放 | 等样本：真实越界尝试、复证前夹具化变体、抗钓鱼探针触发拦截任一出现 | 0036 0037 |
| TD-197 | zcode 后端：隐私尽调的观察期未结；隔离通道下评分走的是非隔离目录，待复验 | 开放 | 等样本：下次交付隔离演练复验；隐私观察期未结 | 0067 0074 0075 |
| TD-199 | zcode 工具事件改为增量落盘之后，读侧投影与在途包容门没有在真实的交付运行里验证过 | 开放 | 等样本：下次受督的长运行或 zcode 交付运行 | docs/usage.md |
| TD-201 | dsh 组件层在册证据基于 0.1.5-rc.2 旧指纹，现装 0.2.0-rc.2 后旧证据 inconclusive 且不可由 component-check 重建 | 开放 | 等样本：coder_low_dsh 席位承重前，或 dsh 0.2.0 正式发布 | scripts/reliability/dsh-acp/evidence/ scripts/reliability/dsh-acp/wao-reuse-drill.mjs |
| TD-204 | 认证 caseId 仍以 label 为合并键，改名即换键，仅 warn-only 护栏在线未解耦 | 开放 | 择机：下次改认证台账 schema 时解耦 caseId 与 label |  |
| TD-206 | kimiWeb 失败 run 的部分产出不落盘，中途失败后已产出文本不可恢复 | 开放 | 等样本：受督 kimiWeb 长 run 需要中途产出可恢复 |  |
| TD-209 | runner 无声挂死根因与延迟收割者身份未明，复现时需带现场归因；心跳盲区已缓解 | 开放 | 等样本：再遇同形（无声悬置+心跳活+计时器在场）带现场归因 | test/isolation-infra/backgroundRunner.test.js src/backends/kimiWeb.js |
| TD-210 | CLI 已钉新版且自动更新已关，wrapper 通道在新版下的回归验证未做 | 开放 | 等样本：下次启用 wrapper 车道时先做回归验证 | 0045 src/backends/claudeCode.js |
| TD-212 | certification 视图答不到组合验到什么程度，矩阵投影未实现 | 开放 | 择机：下一轮生成器维护窗做矩阵投影 | scripts/gen-certification.mjs |
| TD-216 | 判定失败是否新引入仍需自建基线对照，一键差分工具未落地 | 开放 | 等样本：fixture 权威化落地后复测红盘再定 |  |
| TD-219 | acceptance 落盘已落地，但仓库外写入任务走不了交付管线，expectedWriteRoots 与 manifest 第二步未落地 | 开放 | 等样本：仓库外写入任务族再临 |  |
| TD-220 | 投影与标签已修，但 shell 介导写入不产事件且无写根比对锚，读侧新鲜度与事件时间戳失真仍挂账 | 开放 | 等样本：写根比对锚随 TD-219 后步；其余挂账未定 |  |
| TD-222 | workspace 绑定下 readOnly 席位建隔离 worktree 确定性失败，consult 不可用 | 开放 | 等样本：再遇同形失败或 consult 维护窗 |  |
| TD-225 | workspace 绑定强制 git 仓库，非 git 任务需现造锚点仓库并事后清扫 | 设计性约束 | 需要时现造锚点仓库，任务完成后顺手清扫现场 |  |
| TD-231 | repackage 的 validateInput 严校验、CAS 形状不变量、commit 失败、Git 异常等拒绝路径仍为裸意外错误 | 开放 | 择机：触碰 repackage 时把拒绝路径从裸意外错误改为闭集拒绝 |  |
| TD-241 | 成功面 text 仍与 structuredContent 双份全量 JSON（C1 挂起），kimi/opencode/zcode 三宿主消费行为未探 | 开放 | 等样本：C3 实测截断，或未探宿主证据显示成功面 text 被消费 | 0051 |
| TD-243 | 转录解析 cwdHint 接线为零调用点，桶数超上限即写侧不可用且无快命中时查询付全扫描成本 | 开放 | 择机：接线前先测真实桶数增长曲线 |  |
| TD-244 | 前台 isolation 失败时转录首事件缺 project 事实，被判 unattributed 且迁移闭集缺该类型 | 开放 | 择机：随下次触碰前台 isolation 失败路径修（触发面低频） | src/runManager.js |
| TD-245 | 运行认领文件永不删除、每次仲裁全量列目录；四个需要持续 IO 故障才触发的理论窗口已接受 | 设计性约束 | 认领目录列举成为瓶颈，或真实撞到并发认领 |  |
| TD-248 | interference 登记册的交付保留路径仍靠派发纪律保护，机器化未落地 | 开放 | 择机：触碰派发纪律面时把交付保留路径机器化 | 0054 |
| TD-250 | kimi 上游不回收会话进程荚；serve 整体空闲退出（0079）后荚随 serve 拆除、基本不再堆积；failed 会话的清扫判据没做 | 开放 | 等样本：failed 会话堆积再现时做清扫判据 | 0056 |
| TD-254 | readOnly×lead_workspace 错位与 resume 源仓两缺口仍未修 | 开放 | 等样本：隔离边界崩溃恢复族另案观察 | 0058 |
| TD-260 | 若干收口项（红队补记、supersedes lineage 事实、交付收条等）登记未实施 | 开放 | 择机：Owner 点名后实施各收口项 | 0062 |
| TD-266 | worker 会读宿主仓库的规则与概况文件，连同任务需要读的内容一起发给车道背后的模型方 | 设计性约束 | Owner 2026-10-15 裁定：用户自己选了车道，就是同意把项目内容发给对应的模型方，要保密可以改用本地模型；WAO 不做读取范围声明，也不做按项目的车道白名单 | AGENTS.md |
| TD-267 | MCP 的 run_delivery 在验证排队时不带验证闸信息（CLI 已带） | 开放 | 等样本：走 MCP 的 Lead 再报验证排队盲区 | 0066 |
| TD-270 | deepseek 两后端仍无静默期取样（processActivity 只接 processBackend/zcode）；0072 起命令在跑已对 Lead 可见 | 开放 | 择机：下次改动 deepseek 后端时接静默取样 | 0070 0072 |
| TD-271 | 评分与 run_activity 的退出码推断仍是两套实现；0073 起两道门效果已一致，仅未并轨 | 开放 | 择机：下次改评分或活动投影时并成一个判据 | 0072 0073 |
| TD-272 | deepseek-acp 的 extractExitCode 读平铺文本块，线上数据是嵌套块，从不生效；候选删除 | 开放 | 择机：下次改动 deepseek-acp 时删除（toolResultText 已明确不接线） | 0073 |
| TD-273 | `config/lane-exceptions.json` 的五条例外对退出码轴已非必需，未清理 | 开放 | 择机：下次例行认证时清理 | 0073 |
| TD-274 | kimi 车道出现过上游 `Request timed out`（发生时只有一个任务在跑），原因未查明 | 开放 | 等样本：上游 Request timed out 再现时带现场归因 | 0073 0074 |
| TD-280 | zcode / kimi-web 的严格评分演练以 failed 收尾（认证判定仍是不适用），认证演练没有重跑 | 开放 | 择机：下次例行认证时重跑 | 0072 |
| TD-281 | requireCommands×无退出码后端：registry validate 已有警告（0072），派发时刻仍无提示 | 开放 | 择机：下次改派发前检查时把警告接到派发面 | 0072 |
| TD-292 | 交付打包的异常信息匹配不上已知措辞时，transcript 只写 "delivery packaging error"，连安全的错误类别（如文件锁、git 启动失败）也不给，Lead 看不出该重打包还是该查环境。已见两次（run_20261014092633812jgm07h、run_20261014100010561p9ukkz）；Lead 事后在原工作树用同一输入重做打包检查都通过，但没有留下记录，原因未查明（疑为 worker 收尾时的 git 命令还占着 index.lock） | 开放 | 下一批：诊断批次把安全错误类别（文件锁、git 启动失败等闭集）投影进事件 | src/runManager.js |
| TD-294 | `npm run smoke` 只探测 claude 与 codex（opencode 要点名才跑），入库模板里的 zcode、kimi-web、deepseek-acp 车道都不在 smoke 内；milestone-discipline §4 却要求涉及外部系统的里程碑收尾必跑 smoke | 开放 | 择机：下次改 smoke 或这些后端时把模板车道纳入，或在 §4 写明替代 | src/smoke.js docs/milestone-discipline.md |
| TD-304 | 终态额度正则的一个分支会把 "tokens per min limit reached" 这类措辞归成 `quota_exhausted`，而分钟级限流会自愈、恢复方式不同；这句是构造的措辞，OpenAI 实际的 TPM 报错归 `rate_limited`，尚无真实误归样本 | 开放 | 等样本：真实误归样本出现时按窗口长短区分限流与额度耗尽 | src/diagnosis.js |
| TD-307 | 分桶（D2-②b）后仍按平铺布局找转录的残留：三个独立脚本拼 `<runDir>/<runId>.jsonl` 读转录；两个复用演练的负向用例还往平铺路径改写前任转录（与桶内原件成哈希不同的孪生），并用顶层快照断言被拒的派发不留新转录（看不见桶内新增）；long-run-probe 只枚举顶层；drillEvidence 的 drillTranscriptPath 无调用方 | 开放 | 择机：下次运行这些脚本前改走 projectBuckets 解析链 | scripts/dispatch-with-liveness.mjs scripts/reliability/session-reuse-drill.mjs scripts/reliability/dsh-acp/wao-reuse-drill.mjs scripts/long-run-probe.mjs |
