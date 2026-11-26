# 0097 选车道的关键事实送到 Lead 面前：成本档、实测分数、Owner 规则一处，派发时回显所选车道的事实

- 日期：2026-10-30
- 状态：accepted
- 来源：
  - 2026-10-30 Lead 在 GLM 高峰把一个后端实现任务派给了 kimi。Owner："后端代码层面，deepseek-flash 的能力是不弱于 kimi 的，甚至部分强于 kimi"；"kimi 的价格是 deepseek-flash 的十倍以上"；"我怀疑是 worker 画像中没有给 lead agent 提供足够信息"。
  - Owner 同日：成本档 glm-flash 0.5、deepseek-flash 1、glm-pro 1（GLM 高峰消耗 ×3）、opus 3、sol 4、kimi 4、astra 5；保留 5 星、在星级旁显示实测分数与样本量；退役"glm-pro 周额度用尽时让 opus 顶"（10-15）——"letting the facts decide……这是正确的方式和态度"；"我偏向于在 glm 订阅高峰期使用 glm-flash"；反对把选车道的要点写进 Lead 的私有记忆——"这样无法测试我们的优化调整是否生效"。同意本批范围与 MCP 工具面重冻（决定 0078）。
- 关系：修订决定 0087 §5"画像只出现在 lead_preflight.lanes"：派发受理回执附所选车道一行事实（第 4 条）。沿用 0090"车道怎么用只有一个家"与 0092 的标注纪律。
- 方案会审：opus 与 deepseek-flash（consult_20261030073553871k7p249）。

## 背景

- 当时 `lead_preflight` 已经写着决定性事实：kimi 写代码 3★（n=2，每题 20–21 分钟），成本"价格高昂"；deepseek-flash 写代码 3★（n=8，隐藏测试 107/112，每题 10 分钟），成本"极便宜"；glm-pro 的注意事项写着默认实现车道、高峰外派。四条可实现车道星级都是 3，区别只在样本量、note 和成本原文里。
- 没有私有记忆的无头 Lead（Sonnet）只读 SKILL 与 `lead_preflight` 的 `lanes`，在 8 个场景里没有把实现派给贵车道；弱点是能力打平时不看成本（方案会审选了 sol 而不是 deepseek-flash）。出错的是一个长会话 Lead：它没读 `lead_preflight`，只 grep 了 `wao lanes` 的星级行，又依赖私有记忆里的规则。
- 成本是自由文本，不可比较；跨车道的规则散在单车道注意事项里，另有几条只在 Lead 的私有记忆里（已删）。

## 决定

1. **成本档 `costTier`**：Owner 给的相对档位，0.5–5、步长 0.5、数越小越便宜；不是价格倍数，取非高峰基础档，高峰倍率看 `cost` 原文。未给为显式 null。只有 Owner 改它；车道换代时随认证巡检复核。值不合法时只把这一格当 null 并报观察，不让整条车道从视图里消失。
2. **实测分数 `score`**：`{hits, total, label}`，只用于 measured 格，且只计该格 `n` 所数的那批样本（如写代码 n=2 题里的 28 个隐藏测试，所以 `total` 不必等于 `n`；glm-pro 写代码的 n=19 是真实批次，没有这样的计数，不给分数）。只放在调研、写代码、把关三格。数字进了 `score` 就从 note 里删掉，只留一处。
3. **`ownerRules`**：决定"哪条车道做什么"的 Owner 政策只放这里，排在前面的优先；单车道注意事项只留怎么用这条车道。实测不改它们。不合法时只把 `ownerRules` 置 null 并报观察，各车道行照常。
4. **派发时回显所选车道的事实**：CLI `wao run` 在派发时往 stderr 打一行，MCP `run_dispatch` 受理时带可选字段：所选车道的成本档、已评维度的星级与样本量、评分状态，加一句"只陈列事实，不是推荐"。不列替代车道，不比较。`run_continue` 不给。画像读失败就省略这一行，不影响派发。
5. **`wao lanes`** 开头先打一屏对照表（声明序，不排序），再列 `ownerRules`，细节照旧；`lead_preflight` 的 `lanes` 带 `costTier`、`score`、`ownerRules`。SKILL 补一句平手时的比较顺序。

## 否决的备选

- **10 星**：平手不是精度问题；实测比例本身比任何星级都细，样本小（n=2）时更细的档位只会把噪声变成排名；Owner 手感分在 10 档上前后难一致；全部重评的成本高。
- **派发回执列出"更便宜的替代车道"**：是一个确定性推荐器。每次空闲时段按 Owner 规则派 glm-pro，都会被提示 glm-flash 更便宜；它也读不懂"只做会审"这类规则。
- **成本档进 `registry_list`**：0087、0090 已否决画像的第二个 MCP 出口。
- **选车道规则留在 Lead 的私有记忆**：别的 Lead 看不到，也无法测试 WAO 的改动是否生效。

## 已知边界

- 成本档是静态的：GLM 高峰的 ×3、DeepSeek 高峰价都只在 `cost` 原文与 `ownerRules` 里。
- 本批加了 `lane-traits.json` 的新键：没重启的宿主 MCP 进程用旧代码读新文件，会把每条车道判为无效，`lanes` 为空，直到重启（`lead_preflight` 的服务端版本告警会提示）。
- 派发时那一行出现在 Lead 已经选好车道、写好任务书、发起派发的那一刻；它让错误在重派代价最小的时候被看见，挡不住派发本身。CLI 在受理前打印（与 dispatchHold 提示同一时点）：在这之后才被拒绝的派发（如任务书文件读不到）也会先打出这一行，在这之前就被拒绝的不会；MCP 只在受理时带。
- 评测只测"给了事实之后会不会选对"，测不到"长会话 Lead 跳过事实"；后者靠第 4 条。评测的场景、答案键与结果见本批提交说明。

## 修订（第 152 批，2026-11-26）

- 服务商高峰时段从 `cost` 原文移到车道上的 `peak` 字段（北京时间、工作日、`HH:MM-HH:MM` 时段；法定节假日不识别、按工作日算，Owner 定）。`wao lanes`、`lead_preflight`（行内 `peakNow`、顶层 `now`）与派发回显据此显示"此刻高峰／非高峰，至几点"。这是世界现状的事实，不是推荐：WAO 不算"此刻该派谁"，不排序、不隐藏、不拦截。上文"成本档是静态的、高峰倍率只在 `cost` 与 `ownerRules` 里"作废；`ownerRules` 不再写钟点。
- 对照表的分数单元格去掉百分比，只留星级与 n：不同维度的分数口径不同（谱系一次落地、隐藏测试通过），并排的百分比会误导；具体分数留在逐车道细节。
- `ownerRules` 按场景重写为六条（Owner 2026-11-26：日常写代码 glm-flash；较难的非高峰派 glm-pro 或 deepseek-flash，高峰或拿不下时派 sonnet，opus 最后兜底；sonnet、opus、fable 共用一份 Claude 额度）。SKILL 的选车道句改为"照 `ownerRules`，其余由 Lead 判断"，不再另列一套平手顺序。
- 本批同样新增了 `lane-traits.json` 的键 `peak`：没重启的宿主 MCP 进程用旧代码读新文件时，旧校验器把带 `peak` 的四条车道（glm-flash、glm-pro、deepseek-flash、deepseek-pro）判为无效：`lanes` 的行与派发回显里没有它们，只有 `wao lanes` 的"形状错误"和 `lead_preflight` 的 observations 提示；其余车道与新规则照常显示（会审与复核实测）。重启加载新代码后恢复完整画像。

## 修订（第 153 批，2026-11-26）

- 车道加 `quotaPool`（额度池名，同名车道共用一份额度）。`wao lanes` 在成本档说明后列一行"共用额度"（只列两条及以上的池），逐车道成本行带池名；`lead_preflight` 行内带 `quotaPool`。"与某车道共用额度"不再写在 `cost` 原文里。
- `wao lanes` 默认只报例外：接线一致、评分当前、无注意事项不占行，没评的维度合成一行；evidence、source、sha256 收进 `--evidence`。"只陈列、不推荐"只在标题行说一次。
- 没重启的宿主：旧校验器不认 `quotaPool`，十条车道都判无效，`lanes` 行全部消失，重启后恢复。
