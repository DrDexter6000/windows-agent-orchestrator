# 0064 lane-traits 读取面（wao lanes）+ seatRole 语义澄清

- 日期：2026-10-12
- 状态：accepted（Owner 批 A0+A1："同意按此方案推进"）
- 背景：Owner 问询 seatRole 与初心落差（consult_20261012080552840c3pu91 三方会审：opus/sol/kimi 收敛=A 两轴分离——seatRole 保持会审体检语义、lane-traits 活化为 Lead 只读查询面、不进派发解析面、CLI 优先）。前轮实锤：lane-traits.json 在 src/ 零消费且全仓无文档指针（初心"参考信息"载体不可发现）；seatRole 是 W4d 后会审分类唯一活信号源但语义被误读为"车道能力声明"。
- 方案会审：consult_202610121021490657ur8lp（opus 4976 字 6×P1 + sol 4196 字 4×P1——重叠合计 10 项必改全采纳）。

## 裁定

1. **A1 读取面**：`wao lanes`（wao 命名空间子命令，非顶层）——lanes.json 接线轴 + Owner 画像（config/lane-traits.json 原文）+ 认证简表 + 就绪探测 + seatRole 原始声明一屏，各栏带来源；行序恒=lanes.json 声明序，**零排序零推荐**（语义判断归 Lead——不变量 4/6）。
2. **A0 指针**：docs/team-roles.md 派工策略第 3+7 条 / docs/usage.md seatRole 段+验证安装块——指针非复制（SSOT 法条）。**SKILL.md 指针裁定（首轮全量 316/318 抓回）**：会审建议的 SKILL.md 选席段直指针把文件顶过 Owner 定的 13800 字节 slim-entrypoint 帽（14042>13800，守卫处方="move detail to authority docs"）——撤回，发现路径经 SKILL.md 既有 `docs/team-roles.md` 指针抵达（该文档已含 wao lanes 指针）；Owner 如要直指针需授权帽上调或等价删减。
3. **seatRole 语义澄清（文档面，机制零改动）**：它是会审体检（onboarding/doctor 就绪分级+drift 轴）的默认视角归类，非车道能力声明、不约束实际选席（临场帽子=派发时 role）。终局=0045 §1.2 对抗性派生模型（已批准未落地，登记 TD-264）。
4. **隔离守卫放宽（预告兑现）**：laneTraits.test.js 从"src/ 零引用"放宽为**白名单+导入边双钉**——字面白名单仅 `src/application/lanesView.js`；导入边守卫：lanesView 只准被 commands/lanes.js 引用、lanes.js 只准被 commands/wao.js 引用（mcp/**、dispatchResolution、runManager 等间接引入必红——字面钉抓不住的导入边由边钉住，opus P1-2）。反例经合成夹具清单（绝不往 src/ 写临时文件——manifest 分组并行互扰，opus P1-3）。
5. **--registry 防跨绑成对规则（0064 新裁定）**：单独非默认 --registry 拒绝（同 run 命令 lanesEnabled 语义）；与 --lanes-file 成对显式给出时放行+横幅注记（操作员显式声明两侧权威=防跨绑规则要防的"静默混拼"的反面；测试/嵌入面同用）。

## 会审 P1 落实清单

- P1-1（opus/sol）探测共享：commands/onboarding.js 的 probeCliOnPath/probeKeyEnvSource 加 export（仅新增导出），lanes.js import 同一份——不复制第二套实现。
- P1-2（opus）守卫强度：白名单+导入边+Windows 分隔符归一（toPosix）+精确匹配。
- P1-3（opus）反例不触 src/：literalOffenders/importEdgeOffenders 纯函数化+合成清单反例。
- P1-4（opus）--registry 语义：裁定 5。
- P1-5（opus/sol）seatRole 取值：只透传 registry 显式声明（string|null；null=未声明），绝不经 seatRoleOf 推导（命名惯例对车道键必得 non_seat=推导值非事实）——测试钉死。
- P1-6（opus）单一就绪权威：只显示 readyState（onboarding 同引擎 buildRecommendations 注入 configured 面）；--json 白名单投影（不泄漏 cwd/sessionReuse/missingCredentialEnvNames）；registry 单次读取（readRegistryFn 记忆化注入 inventory）。
- sol P1-1 接线关联：axesEqual/laneAxes/agentAxes 自 dispatchResolution 导出（逻辑零改动），漂移判定=explicit 派发 G4 同语义（"explicit 派发将拒绝"文案）；unwired（键不存在）≠invalid（键在条目无法解析）。
- sol P1-2 权威失败≠空面：ok:false（结构非法）/ok:true+sha256:null（不可读）→ exitCode 1+不渲染正常车道面；合法空表=正常面+注记。
- sol P1-3 认证语义收窄：null≠"无记录"——展示"未取得匹配认证（原因未区分：无记录/身份不匹配/台账缺失或不可读）"；状态原样透传（不止 certified/conditional）；头部明示"台账简表口径（不比较 effort），非当前执行画像适用性结论"。
- sol P1-4 画像降级三态：present/absent（无键）/invalid（该车道形状错误）/unreadable（整文件）；不用默认值冒充观察事实；孤儿画像键/registry 额外键上报不静默丢弃。
- sol P2：MAX_CANDIDATES 64 帽（只注入 wired∩车道键候选，8 车道不触帽）；buildRecommendations 的 advisory 不透传；120 宽折行非截断（displayWidth 同源）；来源标注带括号说明原文照登。
- opus P2：Try: 行从 WAO_SUBCOMMANDS 生成（消手抄面）；manifest 登记（pure 组 +2 文件）；白名单缩到单文件（lanes.js 不出现画像文件名字面量，路径经视图 traitsPath 字段）；traitsSha256 与 lanesSha256 对称。

## 边界（本批不做）

- 画像不进派发解析面/门禁/MCP wire（隔离铁律维持；wao://lanes MCP resource=未来可选第二阶段，落地时须过 gen:surface+wire 审查+0046 "不进 MCP wire"条款修订）。
- 不改 SEAT_ROLES 闭集/seatRoleOf 分类语义/任何既有门禁。
- 不做推荐/排序引擎。
- lane-traits schema 不加日期字段（新鲜度=头部 advisory 文字+重认证；schema 改动=另一批）。

## 实施观察（如实记档）

- BACKEND_CLI 无 zcode 映射（backendCliMap.js 只列 claude-code/codex/kimi-code/opencode-serve/deepseek-harness/deepseek-acp）→ zcode 三车道 readyState 恒 unknown（"backend maps to no CLI"）——**既有权威的覆盖缺口**，onboarding/doctor 同盲，非本批引入；画像面如实显示。待 Owner 决定是否补映射（zcode CLI 探测可行性另证）。
- runs/reliability-summary.json 的 counts 头（certified:2/conditional:7）与 workers 实际（2+6）不一致（opus 红队实锤）——台账数据侧旧账，读取面以逐车道 matched 结果为准不消费 counts；不在本批修。
- loadLanesConfig 对 lanes 非数组静默归 []（ok:true 无 issue）——既有行为，读取面按"合法空表"呈现；结构非法反例须走未知顶层键。
