# 技术债：已了结清单

从台账移出的条目，一条一行（不超过 500 字节），只追加。更早偿还的条目在 [`tech-debt-repaid.md`](./tech-debt-repaid.md)。

表中前 80 行是 2026-10-13 台账重建时判定为已了结的旧条目：「了结依据」引自旧表原文，或写明当时的裁定理由；完整原文见 [`tech-debt-2026-10-13.md`](./tech-debt-2026-10-13.md)。此后的行按了结的先后追加，写的是了结时的依据。

| 编号 | 问题 | 了结依据 |
|---|---|---|
| TD-23 | portAllocator 已实现但 RunManager 未接入，并行实例的端口分配仍未走统一分配器 | 只服务 opencode-serve 的并行实例；opencode 后端不再投入（Owner 2026-10-12） |
| TD-24 | opencode token 只统计 session 级累计而非分轮增量，多轮下仍可能偏高，无法精确归因 | opencode 的 token 统计口径；opencode 后端不再投入（Owner 2026-10-12） |
| TD-81 | TD 表的偿还声明与代码事实之间仍缺机器校验，标为已偿还但代码回退时没有测试会红 | 守的是旧台账「已偿还」节的填写一致性；台账重建后该节不存在 |
| TD-82 | Lead 仍倾向自做而非派工，declare 只是曝光式声明，派工率与使用模式是否改变尚待真实验证 | 工具已落地，剩下的是「观察 Lead 行为是否改变」，没有待办动作 |
| TD-83 | 阶段 pipeline 只能靠声明与 dashboard 缺口曝光，Lead 仍可跳步，是否被引导走完各阶段尚待真实验证 | 机制已落地，剩下的是「观察 Lead 是否走完流程」，没有待办动作 |
| TD-85 | 交付物里写出的 declare/stage 命令文本与实际执行之间没有机器校验，声明可被伪造，只靠纪律与曝光 | 「交付文本里的声明可伪造」只靠纪律，裁定为观察项，没有待办动作 |
| TD-87 | kimi-code backend 不上报 usage，tokenBudget 对其静默失效，根因未修，仅靠 validate 警告提示 | kimi-code 车道已停用，后端的限制并入 TD-117 |
| TD-88 | 派工比自做多一次开销，控制平面看不见 Lead 原生工具调用，自做零摩擦逃逸的根因仍在，降摩擦效果待验证 | 降摩擦工具已落地，剩下的是「观察派工行为是否改变」，没有待办动作 |
| TD-92 | 客观摩擦靠 Lead 手动记录，触发偏晚易遗漏 | 🟢 已落地（2026-07-08）；未覆盖的三项写明是架构上限或已有替代 |
| TD-93 | 块注释含字面量 */ 致整文件解析失败，且缺语法级 smoke 测试 | 旧表原文：「🟢 已修复（2026-07-08）」 |
| TD-116 | coder_hq 脱离 wrapper 直驱 zcode CLI 的迁移构想，Owner 裁定放弃并保持 claude-code | 旧表原文：「放弃迁移，保持 claude-code」 |
| TD-120 | 值指纹守卫把当前策略值写死在断言里，合法变更需双份维护，漏改即假红、留旧值即冻结漂移 | **已转换**（2026-08-15，含会审返工）；余下是一条写法原则，已并入 AGENTS.md 的文档规则 |
| TD-129 | 假 canary 注释让断言看似设防实则无效，转录 SSOT 文档半句矛盾，绑定查找在续跑与活动函数中纪律不一致 | 四项均已修；「全库夹具大扫除不做」是明示取舍 |
| TD-137 | CLI 摩擦四项：runs 裸列表旧优先、三等待上限无交叉提示、runId UTC 无记载、allowedPaths 不收目录 | 旧表原文：「已偿还（2026-08-23 正式批次」 |
| TD-145 | 只读声明的纯咨询 run 零证据，被 scorecard 一律打 hasEvidence 噪声 warn | 旧表原文：「已偿还（2026-08-23，Owner 批准 TDD 小批次」 |
| TD-147 | 上游 stealth 路由对特定请求字段组合静默返回空响应，导致 run 空转 empty_diff | 旧表原文：「2026-09-17 终结：Owner 裁定 coder_ox lane 退役」 |
| TD-148 | 前台 run 观察窗到期会打断事件流并杀死仍在自验的 worker，父进程退出还连坐子进程 | 等待到期不再中止 worker（ADR 0030，见 TD-151 的偿还记录） |
| TD-150 | 上游回归时 run 呈现 completed、零用量、零文本与空交付，转录无异常标记，只能手工定位 | 批 B 已偿还；knsoic 变体写明「显式不覆盖」 |
| TD-151 | wait-timeout到期abort杀worker，后台与resume同患挂起连坐，派发生命周期不统一 | 已偿还（2026-09-18，ADR 0030 落地）；测试缺口由 TD-163 跟踪 |
| TD-152 | 守卫撞车时的内建退避重试未获批，工作区绑定归因只有雏形、仍处观察 | 内建重试未获批，归因「维持观察」，没有待办动作 |
| TD-154 | 观察窗上下限四处碎片化、bundle私藏常量，与执行死线族语义易混淆 | 旧表原文：「档位提案关闭，降级触发式观察」 |
| TD-155 | 手写区与生成层双写同一承重内容时，漂移只能靠人记得改两处，新增双写须随附绑定断言 | 是一条写法纪律（手写区与生成层双写须配绑定断言），已并入 AGENTS.md 的文档规则 |
| TD-157 | 契约校验不探测引用路径存在性，路径写错拖到验证阶段才爆炸 | 旧表原文：「为已知限制（已记账），无其他未竟事项」 |
| TD-159 | 验证失败但工件合格时机器面无出路，reverify误用会烧掉唯一杠杆 | 旧表原文：「已偿还（2026-08-24 同批；Lead 直接实现」 |
| TD-162 | 能力对照表已迁入生成层，registry check 的 CLI help 澄清仍未落地 | 能力对照表已迁入生成层；余下的 `registry check` 帮助文字并入 TD-161 |
| TD-165 | canonical runner无超时杀停，测试挂死即无限期停摆拖垮整波 | 全量 235/235 绿；两项残余写明是有文档的可恢复态 |
| TD-166 | SKILL.md 精简已上线，仍需在真实会话中观察指针读取次数，判断是否切得太碎 | 瘦身已上线，余下是「观察指针读取次数」，没有待办动作 |
| TD-167 | 死run遗留worktree槽位卡派发且报错不指路；scratch指引与守卫白名单打架 | 旧表原文：「已偿还（2026-09-19 顺手小批」 |
| TD-173 | 全量套件已撞本机容量墙，per-test 600s 上限的推导基准被推翻 | 测试预算已按实测重定并经 Owner 追认（2026-10-02，决定 0041） |
| TD-175 | 会审 findings 的处置尚未闭合 | 代码面三项均已修并钉测试；治理项 Owner 2026-10-02 明示追认 |
| TD-187 | seat-certify 索引化阅读试点不满足自足判据，已回退并恢复全文五文件必读入口 | 旧表原文：「已闭合（2026-09-25 Owner 授权回退」 |
| TD-188 | 交付续接曾把本地进程标识当 provider 会话标识致续接失败，已修复，历史 proc-only 记录刻意不迁移 | 旧表原文：「已修复（2026-09-27；候选」 |
| TD-189 | 交付验证测试曾有证明力缺口（缺 PID 即跳过退出证明、外部 sleep 未执行仍通过等），已修复并集成 | 旧表原文：「已验收并按 Owner 批准集成」 |
| TD-192 | 主技术债台账单文件无界增长，已闭合条目原地堆积，认证与契约编辑治理面反复全额征收大文件读取税 | 旧表原文：「✅ 已执行」 |
| TD-198 | deepseek-acp 拒绝相对 cwd 致派发失败；相对 cwd 事实记录致交付审阅 fail-closed | 旧表原文：「✅ 已修已关闭（2026-10-03 已实现」 |
| TD-200 | diagnose 对非终态误称已完成、summary 答非所问、MCP 与 CLI 命名漂移 | 旧表原文：「✅ 已偿还（2026-10-02 关闭批」 |
| TD-202 | 卫生告警疲劳：每次派发弹分支与工作树计数，处置被绕过、帽被抬而非清理 | 警报疲劳根修；帽的清退已于同日完成（决定 0042） |
| TD-203 | --agent 模式下 ambient 回退探针真失败会翻 allPass，认证对象误拿失败退出码 | 旧表原文：「已实施（ambient 失败不翻 allPass」 |
| TD-205 | opencodeServe.request 在 !ok 时把响应正文回显进错误文本，可能泄漏整页 HTML | opencode 后端的错误回显面；opencode 后端不再投入（Owner 2026-10-12） |
| TD-207 | consult 渲染只显示开场白，席位全文丢失于呈现层（数据未丢） | 旧表原文：「✅ 已修已关闭（2026-10-09」 |
| TD-208 | 身份探针仅读进程 env，长命 shell 无该 token 时即失败 | 旧表原文：「✅ 已偿还（2026-10-03）」 |
| TD-211 | harness 能力与验证进度散在多处，拟建独立矩阵文档被否、stash 悬挂 | 旧表原文：「⚪ 归档（2026-10-06）：诉求转 TD-212」 |
| TD-213 | 失败与超时报文缺下一步指引，Lead 需自行探查 run 状态 | 旧表原文：「✅ 已偿还（2026-10-06 收窄版）」 |
| TD-214 | worktree 验证用陈旧 fixture 会假红，fixture 与 live 视角可漂移 | 旧表原文：「✅ 已偿还（2026-10-06）：方案 B 落地」 |
| TD-215 | 长验证超宿主传输上限报 TransportError，需手工轮询 | 旧表原文：「✅ 已偿还（2026-10-06）：有界等待」 |
| TD-217 | consult 席位失败返回空手，无重试续办面，需手工多轮补派 | 旧表原文：「⚪ 撤销独立立项（2026-10-06 三方会审）」 |
| TD-218 | doctor 不检查车道 env 块承重变量，缺变量要到运行期才炸 | 旧表原文：「✅ 已偿还（2026-10-06）：backend 声明表」 |
| TD-221 | 临时隔离目录致用户级技能对派发 worker 不可见且行为无文档明示 | 旧表原文：「✅ 已收口（2026-10-07 Owner 裁定」 |
| TD-224 | collect compact too_large 无降级指路，full 模式长报告切条阅读破碎 | 旧表原文：「✅ 已修已关闭（2026-10-08」 |
| TD-226 | repackage 曾对完全合格的 backend_failed 候选返回裸错误，无拒绝理由与错误事件，零可诊断性 | 旧表原文：「✅ 已修已关闭」 |
| TD-227 | 派发期缺确定性预检，目录形式测试参数与裸 node 选用等根因本可在派发时拦住却漏过 | 旧表原文：「✅ 已修已关闭」 |
| TD-228 | 看板命令退出码永久 unknown 不再升级，correction 类别被渲染成 other | 旧表原文：「✅ 已修已关闭」 |
| TD-229 | native 通道隔离副本续期后新令牌只落副本随目录销毁，原件旧令牌作废致反复登出 | 旧表原文：「✅ 已修已关闭」 |
| TD-230 | 交付验证环境不受部署级开关与 worker 血统标记的环境钉保护，含派发族测试的验证必假红 | 旧表原文：「✅ 已修已关闭」 |
| TD-232 | 终态重取失败时看板先清空最后好快照，呈空加 stale，违保留最后好快照原则 | 旧表原文：「✅ 已修已关闭」 |
| TD-233 | backend_failed 候选打包后写入前崩溃的窗口，重试永久 worktree_unusable，恢复路径不对称 | 旧表原文：「✅ 已修已关闭」 |
| TD-234 | transcript 十处锁内读失败吞成空数组，可能向未读成功的转录追加重复事实 | 旧表原文：「✅ 已修已关闭」 |
| TD-235 | 并发 repackage 回退失败时防洗白守卫按旧测值误放行；readMaxSeq 吞读失败为 0 | 旧表原文：「✅ 已修已关闭」 |
| TD-236 | 交付相关 git 子进程未禁用 replace objects，可被 graft 或整体替换伪造提交欺骗 | 旧表原文：「✅ 已修已关闭」 |
| TD-237 | server 跑旧代码时工具行为与检出不符无从识破，验证闸持有对消费者沉默，指引行缺 drilldown | ✅ 已修已关闭（2026-10-08）；余下的认证欠账问题已由 Owner 裁定 conditional 可接受（决定 0073） |
| TD-238 | 坏 cursor 错误文案塌缩无可行动指引；期望锚仅接受完整哈希拒绝短前缀 | 旧表原文：「✅ 已修已关闭」 |
| TD-239 | runStop 告警在 runDir 缺省时回落进程 cwd 写进仓库根，污染工作区致期望锚被拒 | 旧表原文：「✅ 已修已关闭」 |
| TD-240 | 拒收或人工采纳后的 Lead 侧集成验证无承载命令，只能手搓临时 worktree 加聚焦测试 | 旧表原文：「✅ 已修已关闭」 |
| TD-242 | 两个 CLI 测试长期红被误归因为 PATH 基线，实为席位矩阵重构后的陈旧夹具 | 旧表原文：「✅ 已修已关闭」 |
| TD-246 | 豁免标记可经 agentEnv 继承注入，worker 横幅与守卫矛盾，kimi-web 两臂可达性未明 | ✅ 已修已关闭（2026-10-10）；doctor 检查豁免标记是未采纳的建议 |
| TD-247 | runsGuard 亮红时新增条目缺归属证据行，来源无法定位 | 旧表原文：「✅ 已修已关闭」 |
| TD-249 | 守卫快照只下探一层，已有项目桶内新增 run 不可见 | 旧表原文：「✅ 已修已关闭」 |
| TD-251 | 隔离 worktree 持久化默认无回收终点，树只增不减 | 旧表原文：「✅ 已修已关闭」 |
| TD-252 | kimi-code 历史转录无法认领的限制仍保留，归档面与归档桶认领面的真机验证也未执行 | 余下的是 kimi-code 车道的会话清理；该车道已停用（TD-117） |
| TD-253 | worker serve 的正式车道迁移尚未实施，家目录分离与技能面收窄的收尾仍等 Owner 点名 | kimi 车道已迁到私有主目录的 serve（决定 0074） |
| TD-255 | 套件自干扰三案：波内恒 missing、间歇翻红机制未定、登记册洗白门曾恒拒 | ✅ 已修已关闭（2026-10-11，决定 0059）；间歇失败的后续归因由 TD-181 跟踪 |
| TD-256 | doctor 缺门禁可见性检查且作用域读器为死臂，收账出口与占用门存在死路径 | ✅ 已修已关闭（2026-10-11）；陈旧心跳与认领文件写明只登记不清 |
| TD-257 | README/AGENT_ONBOARDING/llms.txt/changelog 等 onboarding 文档漂移过时 | 旧表原文：「✅ 已修已关闭」 |
| TD-258 | onboarding key 探测漏 kimi-web/deepseek 原生车道；KIMI_WEB_TOKEN 获取文档缺位 | 旧表原文：「✅ 已修已关闭」 |
| TD-259 | 示例模板 glm-flash 缺承重 env 桥、kimi serveUrl 端口与人用 serve 冲突 | 旧表原文：「✅ 已修已关闭」 |
| TD-261 | serve recycle 在 serve 已死时因观测门整体拒绝，重启步还可能因可执行文件解析失败而崩溃 | ✅ 已修已关闭（2026-10-12，决定 0063）；留下的边界记在决定里 |
| TD-262 | 只读树与分支仍有两处回收泄漏：荚占用句柄时不触发回收，崩溃恢复续跑不恢复释放参数 | ✅ 已修已关闭（2026-10-12，决定 0063）；留下的边界记在决定里 |
| TD-263 | seatRoleOf 的 roleStem 分类层生产零接线，误导读者 | 旧表原文：「✅ 已修已关闭」 |
| TD-264 | 对抗性派生终局未落地，人工席位声明仍是体检面唯一分类输入，属过渡态 | ✅ 已修已关闭（2026-10-12，决定 0065） |
| TD-265 | wao stop 对 zcode 运行不生效，非进程占位且无服务地址的会话落进错误分支，运行只能等停滞门 | ✅ 已偿还（2026-10-12，决定 0067）；留下的两项是与 proc 路由同等的已知边界 |
| TD-268 | 会审收据的字段取值在选项互为前缀时记成较短的那个（两席都写 MERGE_AFTER_FIXES，收据记成 MERGE） | 字段值改为整词匹配，声明值不再命中更长取值的前缀（会审链路批次） |
| TD-275 | kimi 偶发把最终答案发成两段相同的文本帧，WAO 按帧拼接后答案重复 | kimi-web 后端略去与上一帧逐字相同的长文本帧，并在事件流里说明略去了几帧（会审链路批次）。真实的重复帧是偶发的，修复后还没有再遇到 |
| TD-282 | 会审或运行超过等待窗口（上限 10 分钟）后没有「继续等」的出口；席位全文和过长的最终回答要调用方自己分页拼接 | 扇出后即落组记录并报出 consultId；新增 `consult wait`；`consult show --seat --out` 与 `collect --final --out` 把全文写进文件（会审链路批次）。等待上限仍是 10 分钟，改为可反复等待 |
| TD-269 | MCP 的 run_consult 改为使用绑定的工作区后，还没有在不提供 roots 的宿主上做过真实调用 | 按桌面端的注册方式在项目外启动服务、客户端不提供 roots：未绑定时派发前拒绝；workspace_select 后一席会审完成，记录落在项目的 .wao/runs/consults，席位在项目的工作树里运行（consult_20261014045643074g0h222） |
| TD-177 | 使用手册以外的现行文档正文仍夹着过程历史 | architecture、certification-runbook、troubleshooting、ssot、team-roles、milestone-discipline、AGENT_ONBOARDING、smoke-guide 与模块页逐份改写为现状描述（两个文档批次），architecture 与 troubleshooting 的字节上限随体量下调；配置注释的同类问题见 TD-295 |
| TD-277 | kimi worker serve 的环境仍带 Lead 宿主的会话变量（`CLAUDE*` 等） | serve 的环境剔除规则加上 `CLAUDE*` / `ANTHROPIC*`（不分大小写），按需拉起、recycle 与手动脚本同一套（`stripServeEnvVars`） |
| TD-278 | kimi worker serve 拉起后一直运行到关机；Owner 已裁定改为空闲退出 | WAO 拉起的 serve 带空闲看护：两面会话列表连续 30 分钟空闲，抢启动锁复核后优雅关停，下一次派发重新拉起（决定 0079） |
| TD-279 | `serve recycle` 不核对新 serve 落在哪个端口，也不取车道声明的工作区作默认值 | recycle 的 `--workspace-dir` 缺省取车道的 `serveWorkspaceDir`；重启后核对子进程落在哪个端口，被挤走就请它优雅退出并记 `ready:false`（与按需拉起共用 `settleOwnServeChild`） |
| TD-161 | `registry check` 只查 opencode serve，命名和帮助文字容易让人当成车道健康检查；各车道的就绪检查没有 | `registry check` 对非 opencode-serve 车道写明它只探 opencode-serve，车道就绪看 `wao lanes`、环境看 `wao doctor`；帮助行同样指路 |
| TD-276 | 声明了 kimiHome 的车道，token 文件是否就绪在 registry_list / doctor 里看不出来 | kimiHome 车道以 token 文件为凭据：`registry_list` 的 `credentialAvailability`、`wao lanes` 的 `readyState`、`wao doctor` 都按文件给出 |
| TD-297 | zcode backend 声明不支持在途纠偏，依据是 0.16.9 的方法表；本机更新后的 bundle 已有 steer 事件与 steerable 活动轮 | 真机（GLM-5.3-Flash）：活动轮里再发 `session/send` 返回 -32010「A prompt is already running for this session」，协议方法表里没有注入活动轮的方法；声明维持 false，翻转条件写在 zcode.js 与 factory.js 的说明里 |
| TD-283 | 车道暂停说明只写在画像展示文字里，派发和会审选席时不出现 | 车道表 `config/lanes.json` 的 `dispatchHold` 是暂停说明唯一的家；`registry_list`、`registry list`、`wao lanes` 与 CLI 派发、会审席位的提示都由它现算，只提示不拦截；画像里的原话移除（决定 0080） |
| TD-296 | canonicalRunner 的 TD-255 端到端用例在 worker 语境里必红（runner 在 worker 语境按决定 0054 关闭自动裁定） | `runTd255RegistryCase` 显式传 `workerContext: false`，不再依赖运行环境；worker 语境下不裁定另有专门用例 |
| TD-299 | 车道当前型号在配置之外有没人核对的副本（文档、模板注释、测试字面值），升级后悄悄过时 | 现行文档与模板注释不写当前车道型号，`docs-consistency.test.js` 按 `config/lanes.json` 现算核对（具体型号的事实用就地标记）；测试字面值钉改为关系检查，W3a 快照与 W1 夹具照旧同 diff 改（决定 0081） |
| TD-284 | Lead 看不出 MCP 服务进程加载的是哪一版代码 | `lead_preflight` 已有的 server build 一行给出服务进程启动时的 HEAD 与检出是否变化，变了出 warning 提示重启宿主；缺的是说明，已写进 `docs/usage/host.md` 的 `lead_preflight` 一节 |
| TD-285 | 用分支代码对真实车道做验证没有成文做法，证据容易落在临时目录 | `docs/testing.md`「用真实车道试用分支代码」写明做法：注册表指向主检出的私有注册表，运行目录用主检出的 `runs/`，MCP 面在工作树里起分支的服务 |
| TD-286 | MCP 工具面的 hostVisible 没有测试守着 | `m12-10-tool-surface.test.js` 加了 hostVisible 冻结线（口径同测量脚本，决定 0078 修订）；23 条描述改为紧凑形，description 11510 → 10125 B，hostVisible 22084 → 20699 B |
| TD-289 | run_delivery_review_bundle 的描述把省略 waitMs 写成即时快照，实际等 270 秒 | 描述写明省略时的默认等待，数值由常量插值；测试从描述取数，再与不带 waitMs 调用时的实际等待比对 |
| TD-287 | 四处偶发失败的测试（mcpBind TXN-03/04、genSurfaceEntry、3B-C4、runManager TD-5） | mcpBind 是回滚时替换或删除文件遇 Windows 占用报 EPERM，改用 `src/atomicWriteSync.js` 有界重试（同 TD-71）；runManager 等待退出前汇合到期事实的写入；3B-C4 等子进程写完的信号；genSurfaceEntry 去掉整目录改名（未复现） |
| TD-288 | 全局命令要写 `wao wao doctor`，帮助页一整屏夹内部编号，`run` 帮助行漏参数 | 顶层裸写的 wao 子命令直接执行（两侧名字不相交有测试）；帮助文本去掉内部编号、一条命令一行，`run` / `spawn` 列出实际参数 |
| TD-290 | 配置键 portRange 没有任何消费者 | 从 `config/default.json` 与 `src/cli.js` 的缺省值里删掉 |
| TD-300 | 安装根提示 `WAO_INSTALL_ROOT` 进了交付验证命令 | 交付验证（含 verify-commit）与验收脚本的环境剥掉它；worker 子进程环境是白名单，本来不含它；WAO 自己重新拉起的 runner、daemon 保留 |
| TD-301 | 后台派发不传 `--isolate` / `--no-isolate` / `--tag` | 后台路径复用前台的 `resolveIsolateFlag`，三态经 runner 原样传到 `RunManager.start`，交付与只读照旧强制隔离；多个 `--tag` 前后台都全部保留（前台原先也只留最后一个） |
| TD-295 | 配置文件的 `_comment` 夹着决定号、批次号、TD 号与日期，入库模板会被用户整份复制 | 五份配置的 17 条 `_comment*` 改为现状描述；`docs-consistency.test.js` 守卫这五份文件的注释不得出现决定号、TD 号、日期 |
| TD-291 | zcode 车道额度耗尽时转录里看不到上游的失败与重试 | backend 读本轮主轮请求的 `model.request.status`：已安排的重试在退避窗内算第四种生命体征（零载荷 `provider_retry`）；收口文案带上游摘要，诊断按尝试链把 429 归 provider_capacity、401/403 归 provider_auth |
| TD-298 | kimi-web 的静默收口在诊断里落 `unknown`，不说明是哪道门 | 诊断给 kimi-web 收口建门表（现行 5 种、历史 2 种文案），serve 不应答归 unknown，其余归 provider_disconnect；真实转录里 11 个历史停滞从 unknown 改归 provider_disconnect |
| TD-302 | MCP 的工作区绑定存在服务进程内存里，多个会话落到同一进程时会串，可能派错项目 | 会动工作区的 9 个 MCP 工具只按本次调用给出的 `expectedWorkspaceRoot` 执行并当场核验，不读进程级选择；已有运行的工具核对运行归属；只读工具照旧跟随选择并标明范围（0021 修订，Owner 批准收窄） |
| TD-305 | 交付隔离门对已存在的工作树内文件调 `realpathSync.native`，失败即判 `write_intent_physical_unresolved` 并终止运行，不重试、不记错误码 | 失败码为 EBUSY/EPERM/EACCES/ENOENT 时整段判定重做（最多 3 次，等 25/100/250 ms），仍无法证明才 fail closed；违规事件带闭集 `errorCode`，诊断事实附上 |
| TD-303 | 别的项目的 Lead 发现的 WAO 问题没有送到 WAO 开发侧的通道，只能写进宿主仓库、靠 Owner 转告 | `wao feedback submit/list/show/close` 写进主检出下的本机收件箱 `.wao/inbox/`（不进 git；任何入口、任何工作树都落到同一处）；`npm run hygiene` 在有未处理条目时多一行提示；决定 0083 |
| TD-293 | 架构 §3.2 与使用手册的事件清单缺了代码写出的 30 种事件，守卫只比两张表、不查代码写了什么 | 事件登记表 `src/transcriptEvents.js`（68 种）是唯一编辑处，清单由 `npm run gen:surface` 生成；所有写出口共用一个序列化函数查表，测试里严格模式下写出未登记类型即红 |
| TD-306 | 在开发工作树里派发的交付运行，运行树嵌在 `.dev/wt/<批>/.wao-worktrees/` 下，`wao worktree reclaim` 把它们算作范围外、永不清退 | 清退纳入经核验的关联工作树（在册、同 common dir、路径无链接）下的运行树：计划记范围证明，apply 删除前重证；重名一律保留并挡住外层树；运行树的位置不变 |
| TD-144 | 宿主进程 env 块不随注册表刷新，setx 后启动的宿主派发报凭据缺失，且无标准补救文档 | 凭据解析已桥接 Windows 注册表（HKCU\Environment，每次派发现读、无缓存：src/application/credentialReadiness.js:7-20，e2cc0b9）；补救文档在 docs/troubleshooting.md §1.6（53e0387） |
| TD-172 | 无会话的非终态 run 无法 stop 与结算，永久计入 unresolved 污染计数信噪比 | `wao runs settle` 落地：runner 已死的非终态 run（含只有 background_submitted 的无会话形状）经六道门结算为 failed（src/application/runSettle.js:3-26、test/application/runSettle.test.js；e6cee6a 说明明言 TD-172 closed） |
| TD-223 | 凭据临时目录回收机制已落地，历史堆积的存量目录清扫未确认执行 | run 终态由 backend.dispose() 删本进程建的目录（src/backends/claudeCode.js）；崩溃残留由 wao doctor 报数、`wao sweep-claude-config --apply` 清扫（src/application/oauthDirSweep.js）；%TEMP% 里 wao-claude-oauth-* 已由 1308 个降到 27 个，存量清扫执行过 |
| TD-292 | 交付打包的异常信息匹配不上已知措辞时只写 "delivery packaging error"，连安全的错误类别也不给，Lead 分不清该重打包还是该查环境 | 打包失败从错误对象的结构化属性分出闭集 errorClass（src/deliveryErrorClass.js），写进 run.delivery_failed 与 run.error；诊断按类别给固定文案（src/diagnosis.js）；原文不回显；test/delivery/deliveryErrorClass.test.js |
| TD-146 | 非交付运行与未打包的交付运行，终态后即使树干净、没有新提交也不回收 | 终态收尾时自动回收干净的隔离树，分支一律保留（决定 0085；src/runManager.js 终态收尾臂与占用扫描、src/isolation.js terminalWorktreeVerdict；test/run-lifecycle/terminalWorktreeRelease.test.js）；存量仍走 wao worktree reclaim |
| TD-196 | 对抗逃逸演练依赖模型配合，守约模型即无靶，发版门槛只能靠豁免 | 决定 0084 组合证明：test/backends/containmentChain.test.js 七个后端的协议帧链式测试；reliability containmentEvidence 2026-10-16 在 kimi、glm-pro、glm-flash、opus、deepseek-flash 实测通过；codex 车道见 TD-309 |
| TD-34 | 文档守卫里钉历史收尾文字的测试，以及读整本手册拼接的检查 | 钉历史的断言逐条退役并写明接续保护；手册的正向检查改读各自的归宿页，负向检查显式读整本手册；要求同一句话出现在三处的 registry 分工守卫退役，权威是生成的 docs/surface/cli.md（test/isolation-infra/docs-consistency.test.js） |
| TD-309 | codex 车道用 shell 写文件，拦截门看不见，调用又不带沙箱参数 | 决定 0086：每次调用强制 workspace-write 沙箱，越界写由 sandboxEnforcement 证明（src/backends/codex.js、scripts/reliability/sandboxEnforcement.mjs）；2026-10-16 sol 的 reliability 全量 certified，sandboxEnforcement 两项通过；astra 未重跑，仍 conditional |
| TD-311 | registry list/check/validate 的作用复述在 README、README.zh-CN、SKILL、AGENT_ONBOARDING、使用手册与排障手册多处 | 唯一归宿是 CLI help（src/cliHelp.js，生成副本 docs/surface/cli.md）；各处改为指向它或只留操作说明（入口文档、onboarding §4d 与 install.ps1、docs/usage/install.md 与 results.md、troubleshooting.md、两处代码注释） |
| TD-201 | dsh 的 phase6 跨 run 会话恢复证据绑定旧运行时指纹，升级 0.2.1-rc.2 后组件层判 inconclusive | 2026-10-17 在 0.2.1-rc.2 上用 deepseek-flash 重跑 wao-reuse-drill：同一 ACP 会话复述标记，三条负向全部拒绝，组件层判 pass（scripts/reliability/dsh-acp/evidence/phase6-session-reuse.json） |
| TD-315 | 行为钉比较 { ...process.env }.PATH；Windows 环境块保留键的原始大小写（PowerShell 启动的进程里是 Path），从这类 shell 跑全量时该用例稳定假红，代码本身无问题 | 2026-10-21：断言改为按大小写不敏感发现键名再比较同一个键，强度不变；本机全量 350→351 |
| TD-314 | 全量里 migration-0045 的 explicitDispatch 往仓库 config/roles/ 写临时角色文件，与同 wave 并发、断言角色库恰好四个角色的 dispatchResolution 互相干扰，稳定假红；另有六个测试也写该目录 | 2026-10-28：七个测试改用角色库真实角色（只读）或系统临时目录的绝对路径，不再写仓库的 config/roles/；写入者与四个列目录的读者并发跑通过 |
| TD-15 | ProcessBackend 的 retries 参数被忽略；自动重试已裁定不做，这个参数是候选删除项 | 2026-10-28：删除该参数与字段；无人读取的 config.retries 也从 config/default.json、cli.js 默认配置、生产代码的 RunManager 配置与两份文档的示例里删除（测试夹具里的同名字段无人读，未动）；HTTP 式 backend 自己的重试次数不变 |
| TD-272 | deepseek-acp 的 extractExitCode 读平铺文本块，线上数据是嵌套块，从不生效；候选删除 | 2026-10-28：删除 extractExitCode 与只供它用的 contentText，命令事件不带退出码（工具结果文本不是退出码证据）；dsh 0.1.5-rc.2 的线上事件字节不变 |
| TD-316 | 心跳判活写了三遍：checkOwnerLiveness 把 Infinity（1e400）与远未来值判新鲜，readOwnerLease 拒 Infinity 却把有限远未来值判新鲜；owner 已死时孤儿 run 不 resume、不回收、不结算 | 2026-10-28：收成 ownerLiveness.js 的 isFreshHeartbeat（有限且与当前相差不超过阈值），三处都用它；Infinity 租约仍判畸形，settle 照旧拒绝 |
| TD-317 | registry validate 原样回显 registry 键名，非法键名里的敏感串会进输出，换行能伪造一行 | 2026-10-28：registry 是合法 JSON 时，非法键名的条目以 1 起序号指代（文本 ✖ #<序号>，JSON 的 id 为 null 并带 position），不回显；文件解析失败时报错带出源文本，见 TD-318 |
| TD-318 | JSON 配置的内容会在报错与文本输出里原样回显：JSON.parse 失败时 V8 报错带出源文本片段；命令的文本输出直接拼配置值，换行能伪造一行 | 2026-10-28：新增 src/safeText.js；registry、roles.json、lanes.json、lane-traits 与两个官方脚本改用 safeJsonParse（报错只带行列号）；registry validate/list/check、doctor、wao lanes、wao onboarding 的文本输出与未知 backend 报错转义控制字符 |
| TD-320 | git_index_locked 打包失败时，run_diagnose 说"有 git 进程还在持锁，它退出后重打包可能成功"；实际多是残锁，这类失败也没有重打包候选 | 2026-10-29：事实文案写两种情形（仍在写索引、残锁）并明说没有重打包候选；troubleshooting §4.6 写怎么分辨、怎么出去。不新增恢复类型：WAO 的只读调用已不写索引（603d5eb），worker 自己的 git 被杀仍可能留残锁，按 §4.6 处理 |
| TD-319 | CLI 与 MCP 的报错直接拼配置值（候选列表、cwd、凭据变量名、serveUrl 等），值里含换行就能伪造一行 | 2026-10-29：两个输出口统一转义：CLI 报错经 renderErrorText，MCP 的 register 包装每个工具返回的 isError 文本与 handler 抛错；有意分行的报错用 linesError 或行数组逐行转义。MCP SDK 自己产生的错误（未知工具、入参与出参校验）不经这一层 |
