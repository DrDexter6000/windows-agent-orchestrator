# 0065 0045 §1.2 终局执行：对抗性派生取代 seatRole 人工声明（TD-264 关账 + TD-263 随关）

- 日期：2026-10-12
- 状态：accepted（Owner 令"开工"于已批准终局合同——0045 §1.2:42"对抗性从审者车道×作者车道关系派生（取代人工 seatRole 声明）"；模板改版蓄意事件授权链据此成立，opus 会审确认）
- 方案会审：consult_20261012122731994yv6bty（opus 5237 字 6×P1 + sol 2484 字——全采纳；其中 opus P1-1 推翻 Lead 原设计：deriveIndependenceRelations 已在 consultService.js:695（0045 R4）存在，且 agentId 字符串比对依据本身错误——旧席位名漏报回避、同指纹双键虚报跨车道）。

## 落地

1. **派生编排层** `src/application/panelDerivation.js`：不持第二套判定——车道关系复用 deriveIndependenceRelations（指纹比对三态）；席位侧=registry 归一化条目四元组指纹（登记时配置事实）；作者侧=被审 run 的 run.started 钉住事实（deriveStartedIdentity，绝不反查当前 registry）；多作者 fail-closed 合并（任一同车道=same_lane > 任一缺事实=unknown > 全可比全不同=different_lane——实施期测试实锤初版把不可读作者滤出导致折叠，已修）；pairwise 席位间族系（stage 2 无作者上下文面）；basis 来源声明必带。
2. **运行面接线** `wao stage 2/4 --panel-seats <a,b> [--reviewed-run <runId>[,<runId>]]`：门=必须与 --panel-seats 同给（错用 fail-fast 不静默）；作者从转录绑定读（observeAuthor 逐事件核 runId）；回避违反（同车道）stderr 大声提示+记录（**advisory 不阻断**——0023 性质不动）；waoStage.addStage panel.derived 闭集形状校验+frontmatter panel_derived_json+正文派生段（map 行第 5 列不动）；core 不 import application（分层）。
3. **体检面切换（多样性口径）**：panelReadiness 候选=全部行（0045"角色是帽子"——researcher/tester 老角色名键照常计数）；tier=ready 候选计数（探测口径措辞）；missingAdversarial 废止→insufficientFamilyDiversity 升主提示；doctor 静默条件=three_seat 且已知族系 ≥2（三席全同族不静默——假全清防线从"零对抗席"平移到"零跨族"，opus P1-3）；配对改全候选跨族扫描（修复"首席未知吞掉后续跨族对"反例——sol）；duplicateModelKeys 同 backend+modelId 多键点名（opus P2 轻量版）；doctor panel 行过归一化门（与 onboarding 同口径，无效条目不进计数——sol）。
4. **seatRole 机制退役**：registry SEAT_ROLES+闭集校验删除；normalizeAgent strip（不原地删输入）；validate 弃用 advisory（不回显值）；panelReadiness.seatRoleOf 删除（TD-263 roleStem 死层随宿主共关）；onboarding drift 轴（0062 B9 乙′）+doctor 指针行 supersede 删除；模板 8 席声明删除（_comment_seatRole→_comment_panel_derivation）；wao lanes seatRole 列删；长尾 PR-3 测试删（WF-1/CR-2 保留）；componentDrills DROP_AGENT_KEYS 保留 seatRole（老 registry 组装兼容——opus）。
5. **私有副本时机（opus D4 反例）**：config/agents.json 的 8 个 seatRole 字段**保留至本批合入 main 后再删**——旧版本代码（v0.4.0/旧 worktree）读到删字段的 registry 会按命名惯例把车道键全判 non_seat（tier=none 误导）；新代码 strip+advisory，留着无害。

## CLI JSON 破坏性变化清单（opus P1-4）

- `wao onboarding --json`：行去 seatRole；panelReadiness 去 missingAdversarial/adversarialIds/implementationIds，加 keyOnly/duplicateModelKeys。
- `wao lanes --json`：行去 seatRole；sourceNotes.seatRole→panel（派生指引）。
- doctor JSON：panel_readiness 文案多样性口径；registry_loads 回基线形态。

## 边界（不做）

MCP wire 零改动（run_consult 记录富化=P2 留档——触碰 mcp/server.js 不必本批）；0019/0023 advisory 性质不动（派生=事实+WARN 永不自动拒）；roles.json/角色库/lane-traits 零变化；认证清单不当配对过滤条件（新门禁范围，本批不做——opus②：deepseek-pro 可能被配对推荐如实记档，配对行自带 readyState 可见）。

## 裁定记录（supersede）

- 0019 §3 席位分配语义（auditor/coder_mm 对抗席惯例）：加修订节——分类退役，作者回避机械化保留并升级（派生违反点名）。
- 0023 R9-C C-1"非席位角色不进计数"：加修订节——0065 多样性口径取代。
- 0024 drift 闭集 seatRole 轴（0062 B9 乙′）：加修订节——轴删除。
- 0062 B9 丙（私有副本 7 席补齐）/0064 seatRole 原始声明列：本档 supersession 记录（不改原档）。

## 会审红队事实修正（Lead 复核全属实）

agents.example.json 为 8 席非 10 席；注记键名 _comment_seatRole；panelReadiness 路径在 application/；consult --reviewed-run 早已存在（cliHelp:17）；deriveIndependenceRelations/deriveStartedIdentity/laneFingerprint 既有权威（identityProjection.js:65/105、consultService.js:695）。
