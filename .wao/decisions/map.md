# Decisions Map

<!-- 索引：所有决策。一行一条，不放正文。渐进式披露。 -->
<!-- 格式：<编号> | <标题> | <一句话> -->
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
0031 | DSH ACP 后端落地方案（B-2） | 经 ACP over stdio 接入 dsh 驱动 DeepSeek；跨进程 session/resume 解 TD-117；双席审查 PASS_WITH_CHANGES 已折叠；status: accepted
0032 | 两层验证与认证（组件层 + 组合层） | llm=verified / backend=conformant / 组合=certified；证据复用而非绿灯传递；分台账、kind 命名空间身份键、lastVerifiedAt 隔离；status: proposed
0033 | canonical 看门狗预算重推导的授权仲裁（auditor R5） | WAO 的宪法级变更控制手段是 declare（可见性+可审计），非 Owner 事前批准（src/waoDeclare.js:26-33 SSOT 枚举，守卫 docs-consistency）；auditor 引据的 Work Discipline 不在 config/roles/auditor.md（35 行全文零命中，:18/:25 反证最终决策归 Lead/owner）；先例 0020 采纳 FAIL 因其 findings 有实证、本批三个[高]已全数采纳；R5 记为 dissent 非缺陷；push 仍待 Owner 明示；status: accepted
0034 | 状态卫生、源头修复与重建平权（Owner 三原则） | 至多一个活续接入口+闭合=归档（移动+墓碑，禁重写）；同类二次补丁前必须源头归因+自声明治标治本；Mainline(3)/ADR 级方案必须含重建行、成本否决权只在 Owner；已决无承重引用的交付收尾连删 worktree+分支；新增规范文本≤10 行零新工具；declare 是披露非授权（部分取代 0033 治理面）；status: accepted
0035 | 卫生机制首批落地（修订 0034 §5 反税边界） | Owner 2026-09-30 批准三层防线方案首批：守卫库存 ≤8（首批 W1-W5 载于 scripts/hygiene.mjs + npm run hygiene：根白名单/墓碑双向/续接入口/分支棘轮 175/注册漂移，红线自带修复命令）；B 类不进交付验证波（R23-D §7）；闭合挂钩 milestone-discipline §8；后续 S2-S5 已批排队（A 类进 npm test/advisory 行/脚手架合同/closeout 独立命令）；否决 pre-commit/cron/新 SOP；status: accepted
0036 | coder_mm kimi-web lane 投用（Owner 例外认定，2026-10-01） | delta 认证 sentinel+scorecard 通过（27K tokens 实测）；adversarialEscape 无靶保留原始结果（K3 引交付合同拒越界，TD-196 承载关闭触发）；边界=delivery+worktree allowedPaths+可信任务文本；台账 conditional（scope=delta）；status: accepted
0037 | coder_hq/coder_low zcode lane 投用（Owner 例外认定，2026-10-02） | delta 认证 sentinel+scorecard 通过（scorecard 4 证据事件含 file_written；usage live 非零）；adversarialEscape 无靶同 0036 形状（GLM-5.3/Flash 双席拒越界，TD-196 适用）；边界同 0036；台账 conditional（scope=delta）；status: accepted
0038 | semver 采纳、v0.2.0 发版基线与 v1.0.0 门槛 | Owner 2026-10-01 选定 0.2.0（非 1.0.0：白天翻绿族未关，稳定声称证据未到位）；版本出口 wao version/--version 补齐（src/version.js，package.json 单一来源，guard 豁免同 help）；v1.0.0 门槛=TD-194 关闭（白天全量首过稳定）；发版门槛沿 milestone-discipline §6.7；status: accepted
0039 | 会审产品化（run_consult）立项与设计契约 v0.2 | Owner 2026-10-02 批准立项（M13 规划中）；机械扇出+收集+council-diff 并列呈现，不做语义合成；三不变式进机器守卫（脱敏记录无损/标记无结论权/malformed 零重发）；修订 0023 仅放开 Lead 显式召集；撤销 A/B 与成本账本；tagline 定稿上线、口号保留；子品牌命名冻结待 Owner 新构想；status: accepted
0040 | 品牌命名终稿 Agent Union（术语包+Soviet 代号+占坑） | Owner 2026-10-02 终审：英文子品牌=Agent Union（合作社/生产队中文别名；Union.ai 相邻碰撞知情披露、auditor 异议在案）；术语包 记工分/工分簿/上工/收工/社员大会；v1.0 代号=Soviet（Fellowship 弃用）；github.com/DrDexter6000/agent-union 占坑已建；M13 以此命名面世；status: accepted
0041 | researcher zcode/GLM-5.3-Flash lane 的 adversarialEscape 例外认定 | Owner 2026-10-02 批准（关闭批三批之一）：delta 重认证 sentinel+scorecard 全绿，adversarialEscape 红=模型守合同拒越界（0036/0037 同族形状，原始 drill 证据按设计随 TMP 清理、以呈报落档豁免回查）；台账 adjudicate → conditional（scope=delta，事实保留）；边界同 0036；TD-196 关闭触发适用；同批另两批：TD-175 R5 追认解读成立（push 禁令解除）、TD-200③ 命名差异接受（映射表+精确配对守卫，⚪ 定案）；status: accepted
0042 | --agent 退出码归属 + 卫生 advisory 弹行规则 | Owner 2026-10-02 裁定：① --agent 模式退出码只归目标 lane（ambient silentTimeout 失败不翻退出码，全量模式不变）；② advisory 三规则（数字变化才弹/帽内无变化静默/超帽恒弹——治警报疲劳）；③ BRANCH_CAP SSOT 迁 src/dispatchResourceAdvisory.js + 只降不升（上调须 Owner 明示+同步双侧只降钉，175→185 系最后一次）；状态文件 LOCALAPPDATA/wao 只存两整数；status: accepted
0043 | 宿主描述符表与接入能力三轴（TD-191①②） | Owner 目标令→双席会审（consult_20261002211156585jgebok）→Lead 落定：hostDescriptors.js 冻结表=宿主闭集唯一权威（snippet/autoBind/hostVerified 三能力正交）；SUPPORTED_HOSTS 派生；bind 对 snippet-only 宿主 emit 片段零写入且明说 NOT BOUND；buildHostExamples 派生消灭第二清单；zcode 入表=dry-run+Owner 真机步骤，dry-run 不计入 hostVerified；MCP 工具面零触碰；status: accepted
0044 | lane 变更与模板改版分离 + drift 侦测扩展（d′） | Owner 2026-10-05 批准（层级 ROI 会审 consult_20261005132336059f49h25 收敛案）：①lane 变更只动 live（席位块+矩阵行+裸跑 onboarding 看 ·drift），模板改版=独立蓄意事件（新认证组合/角色矩阵调整），checklist 两段式；②d′=·drift 闭集扩 effort+认证矩阵行 modelId（drift=展示事实非错误）；③矩阵字段派生缓办（label 兼任 caseId 需专门处理）；判据入册：关系/投影型机制 O(1) 值、镜像型义务 O(n) 不值 | status: accepted
