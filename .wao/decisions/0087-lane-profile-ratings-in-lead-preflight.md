# 0087 车道画像改为分项打分：依据随格，换代待复核，进 lead_preflight，实测格由 Lead 维护

- 日期：2026-10-17
- 状态：accepted（Owner 2026-10-17 批准 Lead 的方案："完全赞同你的所有判断，同意按此推进"）
- 修订：
  - 0046 §1.8 的"不进 MCP wire"，改为 lead_preflight 带只读紧凑投影；"只给 Lead 看、不进派发解析面"不变。
  - 0064 边界第 1 条（MCP wire）、边界第 4 条（新鲜度只靠头部说明与重认证）、裁定第 4 条（允许的导入边）。
- 关系：0076（一项事实一个归宿）、0078（MCP 预算与重冻）、0081（型号只写在配置里）。
- 会审：方案会审 consult_20261017174705586x92l95（sol、kimi）。实现会审记在提交说明里。

## 背景

`config/lane-traits.json`（0046、0064）给每条车道一段 Owner 手写画像，例如"三星智力，代码能力不如 glm"，另附建议用途和几项事实。只有 `wao lanes` 能看，文件里写明"无新鲜度机制"。2026-10-17 暴露出四个问题：

1. **不在 Lead 做决定时的视野里。** `lead_preflight` 只给接线、认证和凭据；Lead 派了一整天活没看过 `wao lanes`，反而在宿主私有记忆里另存了一份车道事实。
2. **一个总分揉合了各项能力。** 同一份台账整理，deepseek-flash 与 Lead 终裁更一致（174 行中 144 对 137），当会审席却判得偏松。
3. **没有出处、样本量和版本绑定。** deepseek-flash 的服务端模型当天换代了，画像无从知道。
4. **只有 Owner 能写。**

Owner 当天提出，画像要有 Lead 参与、不断进化，并进入 Lead 的认知。

## 决定

1. **格式（schemaVersion 2）。** 每条车道包括：
   - `ratings`：七个维度的闭集，即调研整理 `research`、写代码 `code`、抓 bug/把关 `review`、方案设计 `design`、长程自主 `longHorizon`、文案 `writing`、视觉设计 `visual`。每格只有两种形状：
     - 未评：`{stars: null, basis: null}`，不带其它键。未评不折算成任何星数。
     - 已评：`stars` 取 1–5 的整数，`basis` 必填，`note` 可选。三种依据各有要求：
       - `measured`：必须带正整数 `n` 和 `evidence`。evidence 写会审号、运行号或提交号；样本多到列不下时，写可复现的统计口径，统计过程写进那次更新的提交说明；
       - `official`：必须带 `evidence`（官方出处或链接），不带 `n`；
       - `owner`：不带 `n`，`evidence` 可选。
   - 刻度只写在文件顶层的 `scale`：5 是名册里最强、可独立承担；4 强，偶有遗漏；3 堪用，需常规会审；2 弱，需重点把关；1 不适合。打分对象是车道，即模型、harness 与档位的组合。
   - `cost`：一段文字，写计费方式、额度、高峰。额度与高峰的事实只写在这里。不打性价比星。
   - `caveats`：至多 4 条使用注意事项，包括性情一类的行为特点；Owner 的原话标"（Owner）"。
   - `ratedAgainst`：打分时的车道身份（backend、modelId、providerID、effort）。有已评格时必填，全部未评时为 null。
   - `reviewPending`：可选的一句话，用于 Lead 得知 harness 升级或同 id 换模型的情况。
   - 保留 `contextWindow`、`multimodal`、`effortNote`。`concurrencyNote` 只写并发实测。删去 `profile` 和 `suggestedUses`。
2. **待复核。** 满足下面任一条件，该车道即为待复核：
   - `ratedAgainst` 与 `config/lanes.json` 的当前声明不一致（比对沿用 `laneAxes` 的空值归一）；
   - 写了 `reviewPending`。

   全部未评的车道不参与身份比对。删掉 `reviewPending` 并不能消除"身份不一致"。只有已评格都按新身份处理过（重测，或改回未评），才可以更新 `ratedAgainst`。
3. **迁移。** 总分不拆成分项分，也不取整。没有分项依据的格留空。旧 profile 不再单设一句定位：
   - 能力描述经 Owner 确认后，换成 `owner` 格；
   - 价格并入 `cost`；
   - 性情一类的行为特点进 `caveats`；
   - 其余条件事实进 `caveats` 或 `multimodal`；
   - `caveats` 装不下的旧建议用途，由 Owner 取舍。
4. **读取面。**
   - `wao lanes` 显示全部内容。
   - `lead_preflight` 新增 `lanes`，形如 `{scale, dimensionLabels, rows}`：
     - 每行包括 id、七格的 `{stars, basis, n, note}`（note 截到 80 字）、待复核状态与原因、前 2 条 caveats、cost；
     - 行序跟随 lanes.json；单车道非法则省略该行并记一条观察；整个文件不可读时 `lanes` 为 null；
     - 应用层先把字段截到上限，MCP 层再单独校验这一节，不合格时置 null，不连累其余各节，也不影响 `complete`。
   - WAO 不按星级排序、不推荐，也不据此路由。
5. **边界。**
   - 画像不进派发解析、门禁、认证和运行时行为，也不出现在 `lead_preflight.lanes` 以外的任何 MCP 响应里。
   - WAO 不向 worker 投影或注入画像：MCP 服务处在 worker 上下文时，`lanes` 置 null。判定复用派发守卫的 `nestedDispatchContext()`。这份文件本身是仓库里被跟踪的文件，WAO 不负责它的可读性。
   - 守卫规则：
     - 画像文件名只在加载模块里出现；
     - 加载模块只准被 `wao lanes` 的视图和 lead_preflight 的聚合器引用；
     - 聚合器只准被 `src/mcp/server.js` 引用；
     - 只有 lead_preflight 的出参 schema 含画像字段。
6. **写规则。**
   - Lead 可以给未评格首次打 `measured`，也可以凭证据更新 `measured` 格。提交说明写明旧值、新值和依据，汇报时告诉 Owner，Owner 可以否决。
   - `owner` 格只有 Owner 能改。Lead 有相反证据时提议，由 Owner 决定保留还是改为 `measured`。
   - Owner 可以改写任何一格。
   - `official` 格、`cost`、`caveats`、`ratedAgainst`、`reviewPending` 以及其余事实字段，由 Lead 凭出处维护；标了"（Owner）"的原话不改。
   - 防偏：样本量随格记录；未评不扣分；长期未评的车道，由 Lead 安排小样本试用。
7. **预算。** wire 冻结线在本批重冻，硬顶 94,532 B 不动。description 与 hostVisible 的冻结线不抬：description 里提到 lanes 的那几个字，要靠压缩原句等量腾出来。
8. **版本巡检。** `docs/certification-runbook.md` 的巡检收尾加一项：升级或换代的车道写 `reviewPending`。

## 否决的备选

- **纯星级。** 星级装不下条件，也不带出处和样本量，Lead 容易机械地挑最高分。"默认一星"会把没试过写成不行，形成"不派 → 无数据 → 低分 → 更不派"的循环：glm-flash 自 10-08 起再没派过真活。
- **保留散文。** 揉合各维度，没有出处，不绑定版本，也不在 Lead 视野里。
- **在分项格之外再留一句定位。** 这是 Owner 当天提出的问题。定位与分项格、成本的内容重叠，两处会各自漂移，Lead 读到矛盾时不知该信哪一处；行为特点放在 `caveats` 就够了。
- **性价比星。** 性价比随任务而变，单一星数会误导。
- **实测更新先经 Owner 批准。** 太慢；Owner 保留否决权即可。
- **每格单独绑定身份。** 数据冗余；整车道绑定加上第 2 条的复核规则已经够用。
- **派发结果里回显注意事项。** 回显到达时任务书已经发出，影响不了这次派发。如果长会话里 Lead 仍然漏看，再议。
- **画像也进 registry_list。** MCP 上只留一处。

## 已知边界

- 星级仍是判断，各车道接的任务难度不同。跨车道比较时看 `note`，完整依据看 `wao lanes`。
- 同 id 换模型从配置上察觉不到，只能靠 `reviewPending`。
- 长会话或上下文压缩之后，Lead 规划新批次前应重看 `lead_preflight` 或 `wao lanes`。
- 宿主私有记忆里另存的车道事实，由宿主迁进 `config/lane-traits.json`，记忆里只留指针。

## 修订条（0088）

§1、§4 的 caveats 见 0088。
§4 另见 0089。
