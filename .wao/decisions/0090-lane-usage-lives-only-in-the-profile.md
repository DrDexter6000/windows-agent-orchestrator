# 0090 车道怎么用只写在画像：角色与原则文档不写车道名，会审副审来自不同族系

- 日期：2026-10-18
- 状态：accepted
- 来源：Owner 2026-10-18 问"对车道做规则管理和信息注入的渠道有哪些、是否都不可替代、有没有违反 SSOT、能否收紧"。Lead 盘点后提出方案，Owner 回复"同意ABC都做"，并改了会审规则："会审默认 sol + kimi，opus 替补 —— 这句话不对……默认会审我认为遵守两个建议：第一会审应该选不同族系的至少两个worker，第二查bug优选sol"。
- 关系：修订 0046（各角色的默认车道写在 team-roles 与 SKILL）、0023（"跨族系是更强推荐"）、0024（向导矩阵的"适合"段）。画像的格式与读法仍按 0087–0089。
- 合入授权：Owner 2026-10-12——"只要是你联合会审过的，我都许可 commit & push"。

## 背景

1. "车道怎么用"（擅长什么、Owner 的限制、默认派谁）除画像外还写在 SKILL.md、docs/team-roles.md、AGENT_ONBOARDING.md 与模板注释里，测试钉住其中几句。说法已经打架：team-roles 写审计默认 astra，画像写 astra 只用于疑难杂症；SKILL 写审计不可用换 kimi；画像里 sol 的会审实测最严。
2. 模板里 astra 的推理力度是 high，车道表、本机注册表与画像都是 medium（Owner 2026-10-10 调的）。照抄模板配出的注册表，`--lane astra` 派发会被拒；测试把模板钉在 high。
3. 角色职责写了两份：team-roles 的四张表，和 worker 实际收到的 `config/roles/*.md`。两份已经走样：researcher 一边是"不跑测试"，一边是"不跑会改状态的命令"。
4. 向导矩阵的"适合"段读模板的 `_comment_task`，模板早已不写，每行都显示"适合: ?"。会审配对建议不看暂停说明，推荐了"调试中，暂勿派发"的 deepseek-pro。
5. 会审规则（三席、跨族系、避开作者、跳过登记）写在 SKILL、team-roles、AGENT_ONBOARDING、consult.md 四处，测试要求前三处都复述。

## 决定

1. **每类事实一个家。**
   - 车道是什么（backend、model、providerID、effort）：`config/lanes.json`。模板与它逐条一致，由关系检查守住，判定与 `--lane` 派发相同。
   - 怎么接线：模板加 `docs/usage/lanes.md`。模板注释只写接线，用途一律指向 `wao lanes`。
   - 车道怎么用：车道画像，经 `lead_preflight` 与 `wao lanes` 送达。暂停说明仍在车道表。
   - 角色做什么：`config/roles/*.md`。team-roles 只留 Lead 的职责、角色索引表、派工原则与标准流程。
   - 会审怎么组席：SKILL.md 一句。登记与对抗性派生的操作细节在 `docs/usage/consult.md`。
2. **只写在文档或 Lead 笔记里的 Owner 规则，先搬进画像再删文字**（8085ddc）：glm-pro 是默认实现车道；sol 在会审要查 bug 时优先。其余旧派工建议有意不搬：flash 车道做看图、探索与并行小包，画像的成本、能否看图与星级已经表达；"researcher 默认 glm-flash"没有实测支撑（调研整理只有 glm-pro、deepseek-flash 有实测星级）；kimi 写文案、opus 做前端设计已在画像星级里。画像里"替补"一类暗示固定搭配的措辞一并删去。
3. **会审组席按 Owner 的两条建议**：至少两名副审、来自不同族系，写进 SKILL.md；查 bug 优选 sol，写进 sol 的画像。不设固定搭配。
4. **族系进读取面。** `lead_preflight.lanes` 每行与 `wao lanes` 每条带推断族系，由车道表的 backend 与 modelId 推断，展示专用、非契约。sol 与 astra 同为 GPT，凑不成"不同族系"。codex 系型号与 codex 后端兜底都归 GPT 族系，免得没写型号的 codex 车道被当成另一族。
5. **向导与 doctor。** 矩阵去掉"适合"段，换一行指向 `wao lanes`。会审就绪提示不把带暂停说明的车道算作候选，连同原话单列：每条一行、原话不截断；会审本可配时 doctor 也照样列出。
6. **守卫跟着换。** 撤掉三类断言：把车道名钉进 SKILL 与 team-roles；要求 team-roles 与 AGENT_ONBOARDING 复述会审规则；把模板 effort 钉成字面值。新增两条：SKILL 与 team-roles 不出现车道表里的车道名；team-roles 的角色表与角色库一一对应。

## 否决的备选

- **车道表与画像合并。** 车道表参与派发核对，对不上就拒；画像按 0087 不许进派发。合在一起，要么参考数据能挡派发，要么核对变弱。
- **暂停说明搬进画像。** 它要在 `registry_list` 与派发那一刻出现，没看 preflight 的 Lead 也能看到；画像不进这两处（0089 否决了画像进 `registry_list`）。
- **codex 车道被派非会审角色时报警。** WAO 只告知，Lead 拍板；"只用做会审"已经是 preflight 里 sol、astra 的第一条注意事项。
- **team-roles 保留角色表，另加测试比对合同。** 散文比对不可靠，结果只是多一份要同步的副本。
- **保留 `_comment_task`，只隐藏问号。** 那是第二条写车道用途的通道，模板与本机注册表都已不写。

## 已知边界

- 族系按型号前缀与 backend 推断。zcode 车道认不出型号时显示"未知族系"，不参与多样性判断。
- 向导输出的表头仍叫"角色矩阵"，实际列的是车道。改名牵动十几处测试，本批未动。
- `lead_preflight` 只给画像里有条目的车道出行；没有画像的车道，族系看 `wao lanes`。
