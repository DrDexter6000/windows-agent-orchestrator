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
| TD-15 | ProcessBackend 的 retries 参数被忽略；自动重试已裁定不做，这个参数是候选删除项 | 开放 | 下次改动进程式后端的派发参数 |  |
| TD-16 | 真实 CLI smoke 依赖真实 API、登录与费用，刻意不进 npm test、CI 不跑 | 设计性约束 | 涉及外部系统的 milestone 收尾必跑 smoke | docs/milestone-discipline.md |
| TD-29 | 大 DAG 的 completedResults Map 占用内存，无流式或分页机制 | 开放 | 实际遇到大 DAG 时做流式/分页 |  |
| TD-31 | workflow 脚本具备完全 JS 能力，风险与 npm script 同级，属刻意接受 | 设计性约束 | 文档标注即可，无需代码修复 |  |
| TD-34 | 文档守卫有两类遗留：一批测试只钉历史收尾文字（某文档必须出现某句话），被钉的文字因此删不掉、挪不动；使用手册的检查读地图加全部页的拼接，不知道自己保护的是哪一页 | 开放 | 文档体系下一步：按清单逐条退役钉历史的断言，写明由什么接续保护；手册检查改为只读它保护的那一页 | 0076 test/isolation-infra/docs-consistency.test.js |
| TD-41 | abort 测试在全量高负载下偶发失败，缺确定性的子进程退出因果判定 | 开放 | 再次稳定复现时改用 child exit 事件建立因果 |  |
| TD-45 | daemon 自愈已落地，但 supervisor 自身被杀后无法自动重启 | 开放 | supervisor 重生引导（Windows 服务/计划任务）留 v2 | src/daemonSupervisor.js |
| TD-46 | daemon 长跑累积子进程残留与句柄泄漏的根因未修，仅监控告警就位 | 开放 | 更长时长/更高负载触发 health warn 后针对性修 |  |
| TD-47 | daemon IPC 仅请求-响应，tail 依赖文件轮询，无流式推送 | 开放 | 真实需求驱动时再加（SSE 式推送或保留文件轮询） |  |
| TD-50 | 失败分类是启发式信号匹配，边缘 case 降级 unknown，刻意只给证据不给处方 | 设计性约束 | 新增 provider 错误格式时扩充 AUTH_SIGNAL 即可 | src/diagnosis.js |
| TD-84 | 目标项目未 init 时 `wao declare` / `wao stage` 以 ENOENT 崩溃 | 开放 | 跨项目派工再次撞到时 | src/cli.js |
| TD-96 | `wao stage` 每个阶段要手拼 task、artifacts、cwd；按 run 自动填充（`--from-run`）登记了没做 | 开放 | 真实使用里再次需要自动填充时 |  |
| TD-97 | scorecard 的 requireCommands/requireFiles 证据判定仍独立，未并入统一评估模块 | 开放 | 未定 | src/runEvidenceAssessment.js |
| TD-104 | 同一 OS identity 下 worker 仍可读取分配的凭据文件，credential broker 未落地 | 开放 | 无人值守、多租户或强隔离发布前需 credential broker 或独立身份 | 0016 docs/incidents/2026-07-12-worker-credential-exposure.md |
| TD-106 | Tester 上下文效率属 Codex 产品与订阅配额问题，WAO 刻意不吸收该职责 | 设计性约束 | 未定 |  |
| TD-108 | evidence fallback 调用未按 expectedRunId 过滤，跨 run 证据污染仍是理论风险 | 开放 | 出现跨 run 污染实证或需接受混合历史 transcript 时 |  |
| TD-115 | lastHealthyRunAt 非 sticky，重跑失败后新鲜度归空，失败场景拿不到上次健康时间 | 开放 | 若 Lead 实际需要失败场景历史新鲜度，届时再立项 |  |
| TD-117 | kimi-code 与 deepseek-harness 两个后端能力不全（不上报用量、不支持会话复用等），暂停使用、不配车道 | 开放 | 巡检确认能力补足且明显优于 kimi-web / deepseek-acp | 0074 src/backends/deepSeekHarness.js |
| TD-118 | 技能安装是指向仓库根的 junction，改动写盘即生效于所有会话，无提交闸门 | 设计性约束 | fresh clone 后需重新安装 | SKILL.md |
| TD-123 | 全行扫描正则对注释/字符串有假阳性面，application 的 bare 包出边未入方向矩阵 | 开放 | 首次 M9 假红实证，或下次触碰 M9-6A-09/layering 矩阵时 |  |
| TD-124 | 静态规则可被单行 join 逃逸、白名单非行内容锚定、深度2写者未覆盖 | 开放 | 下次触碰守卫/白名单时顺带，或首次真实逃逸实证 | src/application/sessionReuse.js |
| TD-125 | prune 归档有 TOCTOU 覆盖窗、无逐文件容错，子目录语料与顶层日志不在清扫面 | 开放 | TOCTOU 根修待首次真实冲突实证；子目录策略 Owner 需要时另立 | docs/usage.md |
| TD-128 | 读绑定清扫大部分已修，但维持清单仍有约十处无绑定读面：写侧 CAS 三门、seq 水位族、events[0] 类等，外 run 伪造行仍可污染观测或锁死交付决策 | 开放 | 触发条件入册后重看：非人调用方、输出被程序化消费、pre-envelope 存量变非零等 | src/transcript.js src/runManager.js src/backgroundRunner.js |
| TD-130 | 全量测试套件存在多文件多波环境性 isolation_pass 假失败，根因未定位，靠串行闸与复跑缓解 | 开放 | T1/T2/T3 重开触发，如闸独占下再现 isolation_pass | docs/research/td130-root-cause.md src/verificationGate.js src/machineGatePaths.js |
| TD-133 | delta 认证的空转形状、演练卫生面、存量 worker 重跑三项没处理（Owner 裁定低优先，重跑前要先改剧本）；越界写拦截链的实测归 TD-196 | 开放 | 下次车道认证周期 | 0025 0026 |
| TD-134 | runs-guard 只做基线差分不做进程归属，主副本跑 npm test 期间后台 run 落盘即假红 exit 1 | 开放 | 根修（进程归属或隔离 run-dir）待真实痛点再立项 | scripts/canonical-test.mjs |
| TD-135 | 并行会话集成后的语义组合冲突无机制覆盖，集成终验依赖 Lead 手动执行且时机不保证 | 开放 | 首次语义组合冲突致集成后回归实证时；并行成常态时加必做步骤 |  |
| TD-138 | 全量测试约 14 分钟，每个批次的合入都要等它；还没量过哪些文件最慢 | 开放 | 测试相关的批次：先量出最慢的文件，再决定拆分或提速 | docs/testing.md 0077 |
| TD-139 | MCP 的 run_status 不返回最近活动摘要（当初按「安全子集」裁掉）；命令原文已在 run_activity 放开，这条边界该按同一口径重看 | 开放 | 下一次 MCP 状态面改动 |  |
| TD-140 | 运行时硬钉 Node 22 区间，v24 libuv Job Object 回归未修复不能升级，LTS 维护到期即风险 | 开放 | 每季度核对 v24 修复；2027-01 仍无修复迹象则评估迁移 | src/nodeVersionGuard.js docs/usage.md 0027 |
| TD-141 | 机器护栏只覆盖被断言的面。Owner 裁定：再撞见一次未覆盖面的漂移，就出一份「机器护栏对文档化不变量」的对照清单，逐点决定补断言还是接受 | 开放 | 首次再撞见同类漂移 | docs/usage.md scripts/canonical-test.mjs AGENT_ONBOARDING.md |
| TD-142 | workflow / DAG 层利用率低，裁定保留现状不退役 | 设计性约束 | 连续一个季度零 workflow 运行，或该层需要实质改动 | 0027 |
| TD-143 | 证据链层依赖 runtime 厂商 transcript 访问政策，且治理方法论无第二读者与操作者 | 开放 | backend 收紧 transcript 政策时；对外分享或第二操作者加入前补交接文档 |  |
| TD-144 | 宿主进程 env 块不随注册表刷新，setx 后启动的宿主派发报凭据缺失，且无标准补救文档 | 开放 | 第二次撞见同类断层即立项承载 | docs/usage.md |
| TD-146 | failed/aborted 等非交付 run 的 worktree 终态后不自动回收，宿主侧累积垃圾目录与分支 | 开放 | 下次 CLI/资源类 friction 批次顺带承载；再累积到 advisory 阈值即升级 |  |
| TD-149 | repackage 的 allowedPaths 仍硬拒目录/尾斜杠条目，dispatch 收而 repackage 拒；waitWindowHint 缺 MCP 非泄漏钉 | 开放 | 下次触碰 delivery/repackage 面或实际被拒收目录清单时立项 | src/application/runDeliveryRepackage.js docs/02-architecture.md |
| TD-153 | `runs list --since` 不走历史扫描通道；unknown 展示态不能作为过滤条件 | 开放 | 下一次 CLI 查询面改动 | src/scorecard.js src/transcript.js docs/usage.md |
| TD-156 | runs/无保留策略，全量扫描随文件数增长变慢，当前约2-4秒逼近阈值 | 开放 | 扫描耗时破5s阈值即转按年龄归档不删除 | scripts/canonical-test.mjs |
| TD-158 | 上游空窗期的派发重试脚本已收编，还没有在真实的空窗连败里用过 | 开放 | 下次空窗连败时启用，并评估是否转正 | scripts/dispatch-with-liveness.mjs |
| TD-160 | 任务书硬化规则部分落地，绑定断言未见记录，措辞过宽仍可触发workdir_escape | 开放 | 未定 | SKILL.md docs/usage.md |
| TD-163 | 自然清理时进程仍活或探测抛错的证停告警路径缺自然路径等价测试 | 开放 | 下次触碰processStopVerify/cleanup证停面时顺带补 | 0030 |
| TD-164 | 结构化信封试点获 Owner 批准后只跑了首臂，判死条件还没评估（跨模型 KV 直传已裁定不适用） | 开放 | 试点随主线批次；三个重看条件任一满足即重评 |  |
| TD-168 | 测试冗余清扫主体已落地，35 个删并候选仍待人工逐条定谳 | 开放 | 候选低优先逐条定谳；cli.test.js 下次大改时顺带整理 | test/fixtures/mcpWireKeySets.js test/isolation-infra/reporter.test.js |
| TD-169 | 认证通道零 case 仍报 ALL PASS 且 exit 0，缺执行计数；strict drill 覆盖不足可归为 full | 开放 | 阶段 2 处理 | scripts/run-reliability.mjs |
| TD-170 | 全量测试各波的时长没有基线和漂移告警（上次靠人工比对才发现 390s 涨到 600s） | 开放 | 再次出现环境漂移污染验证结论 |  |
| TD-171 | 交付验证遇到环境抖动时，仅有的一次 reverify 机会会被烧掉；deliveryVerification.test.js 在并发下由约 246 秒膨胀到约 600 秒，原因没查清 | 开放 | 是否给环境性失败第二次重验机会，待提请 Owner 裁定；膨胀原因在下次复现时查 | test/delivery/deliveryVerification.test.js |
| TD-172 | 无会话的非终态 run 无法 stop 与结算，永久计入 unresolved 污染计数信噪比 | 开放 | 未定 | 0062 |
| TD-174 | worker 易把写路径指向主仓根，越界即终态 failed 无挽救；分类提示与诊断标注未落地 | 开放 | 未定 | 0062 |
| TD-176 | 缺 model 接线设计入口、中立收紧缺文档可见性、auditor 无 verdict 缺失败归类、复用断链缺可观测信号 | 开放 | 四项独立触发：接线 model、改文档、auditor 无 verdict、排查断链时 | docs/troubleshooting.md |
| TD-178 | live 文档仍有 fresh clone 必断指针，指向运行时状态与 gitignored 路径 | 开放 | 后续文档卫生包时 | AGENT_ONBOARDING.md |
| TD-179 | 验证进程未落 outcome 即死的自动识别（verification_interrupted 事实）与经 reverify 重跑 pending 形态仍未实现 | 开放 | 未定 | docs/02-architecture.md |
| TD-180 | codex 后端间歇性启动期死亡、零写入零 verdict，根因仍未查明；Owner 已裁定不做自动重试 | 开放 | 未定 | 0067 docs/troubleshooting.md |
| TD-181 | 全量测试跨波间歇性失败（波内红、单跑绿、同提交复跑即绿）仍未归因 | 开放 | 归因闭合前按 §8.1 安静窗口单发复验；有界复现待做 |  |
| TD-182 | 会话恢复证据的历史来源不可独立复核，重跑 drill 前不得声称已独立验证 | 开放 | 下一次真实恢复 drill 运行 |  |
| TD-183 | 等待到期与 llm 侧各探针仍不校验探针 run 完成事实即判定，传输层失败仍可能记成假红 | 开放 | 下一次 provider 抖动打到未覆盖探针，或 Owner 裁定推广完成门 | scripts/reliability/componentDrills.mjs src/transcript.js |
| TD-184 | 复用证据已还清；遗留 dsh drill 路由键重算失效待修、codex 转录照不到部分工具调用等小项 | 开放 | dsh drill 修复待排期；原语表 30 天期限钟持续刷新 | 0045 scripts/reliability/session-reuse-drill.mjs |
| TD-185 | 入口判定修复已落地；测试夹具清理仍留空外层目录、构造失败可能残留 staging，早期 22.x 未实测 | 开放 | 下次修改该夹具时收回清理所有权并覆盖构造失败清理 | test/process/genSurfaceEntry.test.js scripts/gen-surface.mjs |
| TD-186 | 认证证据适用性与取证闭环已修多轮；组件层台账历史死指针、过时注释等残留仍未处理 | 开放 | 旧画像不明时不得宣称当前已验证 | src/application/registryInventory.js scripts/reliability/prune-drill-transcripts.mjs |
| TD-190 | 各项目的运行记录已按项目分桶，但都放在 WAO 安装根下，能读该根的本机会话仍可跨项目读到任务书与产出；`agent?.cwd` 归属疑点未复核 | 开放 | 出现需要按项目隔离读取的宿主 | 0060 |
| TD-191 | 宿主接入面仍未全通：三宿主无一条命令注册、派发 advisory 对若干宿主不生效、codex 偶发工具缺失未查、机器安装权威三份并存待收敛 | 开放 | 各残余自带触发；安装权威收敛待 Owner 择期议发布快照方案 | 0066 0049 0043 |
| TD-193 | kimi-web 后端的 WS 事件流、seq 游标重放与按提示中止能力已静态确认但未接线，REST 通道无会话级中止 | 开放 | kimi-web 席位转正或 abort 需求出现时优先做 | docs/incidents/2026-09-30-kimi-web-wiring.md |
| TD-194 | 白天并发跑全量测试套件时随机无关用例抖动（isolation_pass 或空 tail 失败），根因未定，worktree 数量相关性未排除 | 开放 | 下次白天验证 flake 时逐案直跑复现加机器态取证，累计 3 例后立专案 |  |
| TD-195 | 计划内系统重启会打断交付验证并留下 artifact_mutated 形状；WAO 不改系统设置，错峰靠 Owner 配置 Active Hours | 设计性约束 | 不处理 |  |
| TD-196 | 对抗逃逸演练依赖模型配合，守约模型即无靶；拦截链端到端仅有单测未实测，例外席被全量认证机械降级需脚本手工恢复 | 开放 | 任一触发即关闭：真实越界尝试、复证前跑夹具化变体、抗钓鱼探针触发拦截 | 0036 0037 |
| TD-197 | zcode 后端：隐私尽调的观察期未结；隔离通道下评分走的是非隔离目录，待复验 | 开放 | 下次交付隔离演练 | 0067 0074 0075 |
| TD-199 | zcode 工具事件改为增量落盘之后，读侧投影与在途包容门没有在真实的交付运行里验证过 | 开放 | 下次受督的长运行或 zcode 交付运行 | docs/usage.md |
| TD-201 | dsh 组件层在册证据基于 0.1.5-rc.2 旧指纹，现装 0.2.0-rc.2 后旧证据 inconclusive 且不可由 component-check 重建 | 开放 | coder_low_dsh 席位承重前，或 dsh 0.2.0 正式发布时 | scripts/reliability/dsh-acp/evidence/ scripts/reliability/dsh-acp/wao-reuse-drill.mjs |
| TD-204 | 认证 caseId 仍以 label 为合并键，改名即换键，仅 warn-only 护栏在线未解耦 | 开放 | 下次触碰认证台账 schema 时一并评估 |  |
| TD-206 | kimiWeb 失败 run 的部分产出不落盘，中途失败后已产出文本不可恢复 | 开放 | 下次受督 kimiWeb 长 run 需中途产出可恢复时 |  |
| TD-209 | runner 无声挂死根因与延迟收割者身份未明，复现时需带现场归因；心跳盲区已缓解 | 开放 | 再遇同形（run 无声悬置+心跳活+计时器在场）时带现场归因 | test/isolation-infra/backgroundRunner.test.js src/backends/kimiWeb.js |
| TD-210 | CLI 已钉新版且自动更新已关，wrapper 通道在新版下的回归验证未做 | 开放 | 下次启用 wrapper lane 时 | 0045 src/backends/claudeCode.js |
| TD-212 | certification 视图答不到组合验到什么程度，矩阵投影未实现 | 开放 | 下一轮生成器维护窗 | scripts/gen-certification.mjs |
| TD-216 | 判定失败是否新引入仍需自建基线对照，一键差分工具未落地 | 开放 | fixture 权威化落地后复测红盘再定 |  |
| TD-219 | acceptance 落盘已落地，但仓库外写入任务走不了交付管线，expectedWriteRoots 与 manifest 第二步未落地 | 开放 | 等仓库外写入任务族再临 |  |
| TD-220 | 投影与标签已修，但 shell 介导写入不产事件且无写根比对锚，读侧新鲜度与事件时间戳失真仍挂账 | 开放 | 写根随 TD-219 后步，其余挂账未定 |  |
| TD-222 | workspace 绑定下 readOnly 席位建隔离 worktree 确定性失败，consult 不可用 | 开放 | 下次 consult 维护窗或再遇同形失败时 |  |
| TD-223 | 凭据临时目录回收机制已落地，历史堆积的存量目录清扫未确认执行 | 开放 | 存量目录由 dogfood 清扫执行 | src/backends/claudeCode.js scripts/canonical-test.mjs |
| TD-225 | workspace 绑定强制 git 仓库，非 git 任务需现造锚点仓库并事后清扫 | 设计性约束 | 需要时现造锚点仓库，任务完成后顺手清扫现场 |  |
| TD-231 | repackage 的 validateInput 严校验、CAS 形状不变量、commit 失败、Git 异常等拒绝路径仍为裸意外错误 | 开放 | 未定 |  |
| TD-241 | 成功面 text 仍与 structuredContent 双份全量 JSON（C1 挂起），kimi/opencode/zcode 三宿主消费行为未探 | 开放 | 重启条件其一命中才议：C3 实测截断或未探宿主证据显示 text 被消费 | 0051 |
| TD-243 | 转录解析 cwdHint 接线为零调用点，桶数超上限即写侧不可用且无快命中时查询付全扫描成本 | 开放 | 待排期；实施前先测真实桶数增长曲线 |  |
| TD-244 | 前台 isolation 失败时转录首事件缺 project 事实，被判 unattributed 且迁移闭集缺该类型 | 开放 | 待排期；触发面为前台 isolation 失败，频次低 | src/runManager.js |
| TD-245 | 运行认领文件永不删除、每次仲裁全量列目录；四个需要持续 IO 故障才触发的理论窗口已接受 | 设计性约束 | 认领目录列举成为瓶颈，或真实撞到并发认领 |  |
| TD-248 | interference 登记册的交付保留路径仍靠派发纪律保护，机器化未落地 | 开放 | 未定 | 0054 |
| TD-250 | kimi 上游不回收会话的进程荚（车道迁到私有主目录后基本不再堆积）；failed 会话的清扫判据没做 | 开放 | 上游修复后 `serve recycle` 可退役 | 0056 |
| TD-254 | readOnly×lead_workspace 错位与 resume 源仓两缺口仍未修 | 开放 | 随隔离边界崩溃恢复族另案观察 | 0058 |
| TD-260 | 若干收口项（红队补记、supersedes lineage 事实、交付收条等）登记未实施 | 开放 | 未定 | 0062 |
| TD-266 | worker 会自行读取宿主仓库根的规则与概况文件并发给模型方，WAO 没有声明读取范围的手段；交付工作树不含未提交文件这件事也没写进使用文档 | 等待裁定 | 是否由控制面提供读取范围声明，待 Owner 裁定；含敏感内容的宿主接入前必须先处置 | AGENTS.md |
| TD-267 | MCP 的 run_delivery 在验证排队时不带验证闸信息（CLI 已带） | 开放 | 走 MCP 的 Lead 再报同一盲区 | 0066 |
| TD-270 | deepseek 两个后端没有接静默取样，长命令期间 Lead 看不到进程是否在干活 | 开放 | 下次改动 deepseek 后端 | 0070 0072 |
| TD-271 | 评分的退出码推断按后端声明门控，run_activity 的推断仍用自己的闭集，两处没有并成一个判据 | 开放 | 下次改动评分或活动投影 | 0072 0073 |
| TD-272 | deepseek-acp 的 extractExitCode 读平铺文本块，线上数据是嵌套块，从不生效；候选删除 | 开放 | 下次改动 deepseek-acp | 0073 |
| TD-273 | `config/lane-exceptions.json` 的五条例外对退出码轴已非必需，未清理 | 开放 | 下次例行认证 | 0073 |
| TD-274 | kimi 车道出现过上游 `Request timed out`（发生时只有一个任务在跑），原因未查明 | 开放 | 再次出现时带现场归因 | 0073 0074 |
| TD-280 | zcode / kimi-web 的严格评分演练以 failed 收尾（认证判定仍是不适用），认证演练没有重跑 | 开放 | 下次例行认证 | 0072 |
| TD-281 | 评分规则写了 requireCommands 而车道不产出退出码时，派发时没有提示，要到评分才知道通不过 | 开放 | 下次改动派发前检查 | 0072 |
| TD-283 | 车道画像里的「暂勿派发」只是展示文字，派发和会审选席时不出现 | 开放 | 车道批次 | config/lane-traits.json |
| TD-284 | Lead 看不出 MCP 服务进程加载的是哪一版代码：合入后派发进程用新代码，服务进程仍是旧的，要重启宿主才一致 | 开放 | 版本可见性批次 |  |
| TD-285 | 用分支代码对真实车道做验证没有成文做法，注册表和运行目录各自临时处理，证据容易落在临时目录 | 开放 | 版本可见性批次 |  |
| TD-286 | MCP 工具面的 hostVisible（约 22KB）没有测试守着，description 与 wire 只有冻结线和硬顶；不支持延迟加载工具的宿主每个会话都付这笔上下文 | 开放 | 版本可见性批次：给 hostVisible 加冻结线，按决定 0078 的手段减量 | 0078 test/mcp-surface/m12-10-tool-surface.test.js |
| TD-287 | 三个偶发失败的测试：mcpBind 的 P0-1R-TXN-04、genSurfaceEntry 的 EPERM 改名、deliveryVerification 的 3B-C4 计时 | 开放 | 测试批次 | test/mcp-surface/mcpBind.test.js test/process/genSurfaceEntry.test.js test/delivery/deliveryVerification.test.js |
| TD-288 | 全局命令下 doctor / lanes 要写成 `wao wao doctor`；`wao --help` 是一整屏并夹着内部编号；`run` 的帮助行漏了 `--lane` / `--role` / `--explain` / `--tag` 等实际可用的参数，生成层 `docs/surface/cli.md` 因此也没有 | 开放 | 小摩擦批次 | src/cliHelp.js src/commands/run.js |
| TD-289 | MCP 工具 run_delivery_review_bundle 的描述写 waitMs「省略 = 即时快照」，实际省略时等 270 秒（DELIVERY_REVIEW_BUNDLE_DEFAULT_WAIT_MS） | 开放 | 版本可见性批次，与工具描述瘦身（TD-286）同做 | src/mcp/server.js docs/surface/mcp-tools.md |
| TD-290 | 配置键 portRange（config/default.json 与 src/cli.js 的缺省值）没有任何消费者，端口分配器从未接入（已了结的 TD-23） | 开放 | 小摩擦批次：删键，或接入后写明用途 | config/default.json src/cli.js |
| TD-291 | zcode 车道额度耗尽时转录里看不到上游的错误或额度信号：zcode 自己的事件流（`session/events`）里有 `model.request.status`（`model_request_failed` / `model_retry_scheduled` / `model_stream_stalled`），但 zcode backend 只轮询 `session/messages`。诊断现在把静默收口判为 `provider_disconnect`，并写明收口本身不带上游原因 | 开放 | 车道批次：静默期间读 `session/events` 的 `model.request.status`，把失败与重试的有界事实投影进转录（不回显正文） | src/backends/zcode.js src/diagnosis.js |
| TD-292 | 交付打包的异常信息匹配不上已知措辞时，transcript 只写 "delivery packaging error"，连安全的错误类别（如文件锁、git 启动失败）也不给，Lead 看不出该重打包还是该查环境。已见两次（run_20261014092633812jgm07h、run_20261014100010561p9ukkz）；Lead 事后在原工作树用同一输入重做打包检查都通过，但没有留下记录，原因未查明（疑为 worker 收尾时的 git 命令还占着 index.lock） | 开放 | 诊断批次：把错误类别（不含路径与原文）安全投影出来 | src/runManager.js |
| TD-293 | `run.cleanup_error` 由代码发出，但 architecture §3.2 事件清单与使用手册的事件表都没有这一行 | 开放 | 下次改事件表时补上（两表行集由测试双向守着） | docs/02-architecture.md docs/usage/transcript.md |
| TD-294 | `npm run smoke` 只探测 claude 与 codex（opencode 要点名才跑），入库模板里的 zcode、kimi-web、deepseek-acp 车道都不在 smoke 内；milestone-discipline §4 却要求涉及外部系统的里程碑收尾必跑 smoke | 开放 | 下次改 smoke 脚本或这几种后端时：把模板车道纳入 smoke，或在 §4 写明这些车道用什么替代 | src/smoke.js docs/milestone-discipline.md |
| TD-295 | 配置文件的 `_comment` 字段仍夹着决定号、批次号、TD 号与日期，入库模板 `config/agents.example.json` 会被用户整份复制；其中部分措辞被文档守卫钉着 | 开放 | 文档体系下一步：逐个文件改写为现状描述，钉历史措辞的断言随之退役 | 0076 config/ |
| TD-296 | `test/isolation-infra/canonicalRunner.test.js` 的「TD-255/0059 端到端：登记册命中 ⇒ 自动裁定翻绿」在 worker 语境里必红：canonical runner 在 worker 语境（`WAO_IN_WORKER=1` 或 cwd 在 `.wao-worktrees/` 下）按决定 0054 关闭自动裁定，这条用例却假定裁定可用；交付验证命令带上这个文件的 worker 交付因此验证失败 | 开放 | 下次动 canonical runner 或这组用例时：用例显式声明非 worker 语境，或断言 worker 语境下不裁定 | test/isolation-infra/canonicalRunner.test.js 0054 |
| TD-298 | kimi-web 的静默收口（turn 未被观察到、有产出后的停滞、serve 自称在跑但长时间无输出增长）仍按旧规则落 `no_effect` / `crash`，没有像 zcode 那样按收口类型如实分类 | 开放 | 诊断批次：逐种收口判定它说明的是上游还是 serve 的状态，再定类别与证据 | src/diagnosis.js src/backends/kimiWeb.js |
