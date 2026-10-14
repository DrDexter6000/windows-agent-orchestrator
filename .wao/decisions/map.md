# Decisions Map

<!-- 索引：所有决策。一行一条，不放正文。渐进式披露。 -->
<!-- 格式：<编号> | <标题>，一行不超过 240 字节。标题只用来认出这条决定，摘要写在决定档里。 -->
0001 | state read 丰富查询（grep/过滤）
0002 | 单 agent 调 subagent 的 handoff 自动化
0003 | 旧 docs/ 体系迁移到 .wao/
0004 | WAO 开发文档自审：工具文档 vs 过程文档，迁徙适配分析
0005 | 角色矩阵定稿：Lead/Researcher/Coder-HQ/Coder-Low/Coder-MM/Tester/Auditor
0006 | 外部审计收口里程碑（P0-P2 处理）
0007 | Safety+Contract 收口里程碑完成（C1-C6）
0008 | agents.example.json 对齐决策 0005（进程式切线落地）
0009 | 2026-06-24 阶段性反思 — parser 证据链 bug + 臆测纪律
0010 | Lead-UX 方向：从"操作员"到"声明者"（指向 M7 的 UX 设计骨架）
0011 | 验收契约格式：选"用户验收脚本"（spike 收敛三选一，待 owner 确认）
0012 | daemon IPC 选型：命名管道（`node:net` over `\\.\pipe\wao-daemon`，T0b spike 后 owner 拍板）
0013 | 进程隔离 Job Object：复用 Node 内置（v22）vs 自定义实现（行业调研+零依赖约束后 owner 拍板）
0014 | FL7b coder_hq provider instability fallback
0015 | Worker credential boundary: minimize now, broker before unsupervised release
0016 | Supervised Phase 3C may resume; broker remains an unsupervised release boundary
0017 | MCP-first control surface: MCP Server is agent-facing primary, CLI is fallback, shared application services
0018 | WAO mechanical containment — no auto supervision (docs-only product-contract reset; partial supersedes 0010 product direction, retains 0017)
0019 | 方案与验收三方会审惯例（advisory 劝诫级，非门禁；Lead + coder_hq/low 取一避同族 + auditor/mm 取一；Owner 2026-08-15 裁定并细化）
0020 | TD-119 批次会审分歧仲裁：采纳 auditor FAIL
0021 | MCP 工具面字节稳定性分层（追认 M12-16 regime：name/顺序+schema/annotations 哈希冻结、description 天花板下可修订；减面两级；2026-08-16 外部审计触发）
0022 | onboarding 角色矩阵展示契约（Owner 两轮反馈定稿）
0023 | 三席会审产品化
0024 | onboarding 矩阵双源展示契约（已配置行 + 模板候选，0022(6) 部分取代）
0025 | lane 架构与模型×harness 组合权（每角色 ≥1 lane、独立 agentId 并存、delta 认证方案 A）
0026 | lane 认证身份维度补全（provider 指纹与全量新鲜度；fingerprint-only+lastFullHealthyRunAt+台账合并边界钉死；双执行席对比集成）
0027 | 第三方审计处置（Owner 四条裁定：治理称重不裁流程/Node v24 修复观察主路径/护栏体检够用就好；审计七条逐条裁定+TD-140..143）
0028 | zcode-as-backend 放弃迁移保持 claude-code（TD-116 裁定升格归档；重看触发器两腿未满足）
0029 | 认证两段式入册与突发迁移（修订 0025：入册先行+smoke 地板+承重前 delta；死通道原位迁移；取消定期全量重刷）
0030 | 等待到期语义——通知不杀（Owner 方向裁定：语义决策归 Lead；TD-151 根修立项待排期、TD-154 档位降级）
0031 | DSH ACP 后端落地方案（B-2）
0032 | 两层验证与认证（组件层 + 组合层）
0033 | canonical 看门狗预算重推导的授权仲裁（auditor R5）
0034 | 状态卫生、源头修复与重建平权（Owner 三原则）
0035 | 卫生机制首批落地（修订 0034 §5 反税边界）
0036 | coder_mm kimi-web lane 投用（Owner 例外认定，2026-10-01）
0037 | coder_hq/coder_low zcode lane 投用（Owner 例外认定，2026-10-02）
0038 | semver 采纳、v0.2.0 发版基线与 v1.0.0 门槛
0039 | 会审产品化（run_consult）立项与设计契约 v0.2
0040 | 品牌命名终稿 Agent Union（术语包+Soviet 代号+占坑）
0041 | researcher zcode/GLM-5.3-Flash lane 的 adversarialEscape 例外认定
0042 | --agent 退出码归属 + 卫生 advisory 弹行规则
0043 | 宿主描述符表与接入能力三轴（TD-191①②）
0044 | lane 变更与模板改版分离 + drift 侦测扩展（d′）
0045 | 终局身份模型与 0.3.0 一步到位合同
0046 | 席位矩阵模型名化与画像元数据合同
0047 | 防向下派发双层机制
0048 | 2026-10-08 friction 处置三裁定（双席会审 consult_20261008132958144con470 后 Owner 批示按方案实施）
0049 | 安装权威收敛：认 A 单一物理安装（junction 暴露）
0050 | 归档目录布局：平级月桶维持（随项目桶否决）
0051 | run_consult 载荷合同：机械回执+按席分页（0039 修订）
0052 | 洞②修订：显式派发复用开门与失败即弃护栏
0053 | B′ 根修关账与 tester/coder 复用入册
0054 | 干扰形登记册与自动裁定（verdict 派生合同修订）
0055 | 会审席位只读违规自动 FAIL
0056 | TD-250 kimi serve 进程荚泄漏：终态会话卫生+手动 serve 维护族
0057 | TD-251 worktree 生命周期根修+会话仓存量卫生+私有主目录阶梯①
0058 | TD-254 线系闭合出口+TD-253 私有主目录②③④
0060 | TD-256 批：门禁可见性+收账出口+TD-252 收口+D3 存量实迁（含三处旧缺陷修复）
0061 | TD-258/259 批：onboarding 凭据探测面扩展（key_only 两态）+模板两缺陷改版
0059 | 干扰登记册 B2 门修订：文件级失败回响判定（解除死机制）+案 A/B 收口
0062 | TD-260 批：发版检查单（milestone-discipline §9）+frictions 三方会审收口
0063 | TD-261/262 批：serve recycle 死实例复活+重启健壮性+resume 的 ephemeral 恢复
0064 | lane-traits 读取面（wao lanes）+ seatRole 语义澄清
0065 | 0045 §1.2 终局执行：对抗性派生取代 seatRole 人工声明（TD-264 关账+TD-263 随关）
0066 | MCP 宿主适配：注册状态只读探测、六宿主入表、表外宿主通用片段
0067 | 停滞收口的归属：没有生命体征才由控制面收口，有生命体征由 Lead 决定
0068 | 生命体征口径适用于所有车道
0069 | Lead 中止前先探明并说明理由；run_activity 给出命令原文
0070 | Lead 看得到工具调用的输入与输出尾部；进程式后端静默期取样；MCP 硬上限抬高
0071 | kimi 车道的命令在途可见
0072 | deepseek 车道的命令在途可见；评分的退出码推断按后端声明门控
0073 | 命令退出码证据轴不适用的车道评 conditional；deepseek 沙箱建不起来时给出原因
0074 | 车道不靠人工步骤就能用：deepseek 权限模式按车道声明、kimi 私有主目录、同车道并发实测
0075 | kimi worker serve 在派发时按需拉起
0076 | 文档体系：一项事实一个归宿；台账与决定索引守形状
0077 | 全量测试每批只在最终候选上跑一次；只改测试或文档的交付用定向验证
0078 | MCP 工具面的上下文预算、扩面前提与红线
0079 | kimi worker serve 空闲退出：跟着 serve 走的看护进程
