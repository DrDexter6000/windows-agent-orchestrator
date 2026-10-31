# Changelog 2026-10-31 — v0.7.0 发版快照（v0.6.0 → v0.7.0）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-10-31。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`；发版动作：`docs/milestone-discipline.md` §9。
> 范围：tag `v0.6.0` → tag `v0.7.0`：新决定 0095–0101，另有决定 0092 的修订与提交 3fca3ea。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。发版门槛证据在打标后追加于文末（§9 第 6 步）。

## 主题分组（按用户可感知的能力）

### 运行收口时 Lead 会知道，不靠宿主推送（0095、0096）

- `wao runs wait <runId> --until-settled` 每 15 秒判定一次，收口才退出：运行已终态，有交付时原始验证与最新 reverify 链也都有了结果。MCP `run_delivery` 带 `waitMs` 时同样按收口判定等，验证中拒收、reverify 未出结果时不再提前返回。没等到收口的等待、受理的后台派发都附一句 `nextStep`。MCP 的 `run_wait` 下限降到 30 秒，四个等待类工具缺省 45 秒，放得进约一分钟就让工具调用超时的宿主（0095）。
- 待验证的后台交付，等待器能证明验证进程已不在时以 `verifier_gone` 退出 3；`runs settle` 的进程扫描同步收紧：认得前台 `wao resume <runId>`，读不到命令行的 node 进程只看派发之后创建的，daemon 握手读不出时不当作没有 daemon。会审回执与 `consult` CLI 说明怎么接着等没到终态的席位（0096）。
- 会话绑定下，`run_activity`、`run_wait`、`run_await_result` 与 `run_delivery` 读到不能证明属于绑定工作区的运行时，给出专门的归属拒绝与重试提示，不再折成笼统的 `failed`（0097 随批）。

### 选车道的事实送到 Lead 做决定的地方（0097、0098）

- 车道画像一处给出 Owner 成本档、实测分数与 Owner 规则，`lead_preflight` 的车道行与 `wao lanes` 开头的一屏总表都读它；派发回显所选车道的事实（0097）。`lead_preflight` 车道行加 `videoInput`（0098）。
- 画像以事实为准：被实测推翻的 Owner 评语，经 Owner 确认后可以删掉（0092 修订）；成本说明只留订阅、额度、高峰倍率与价格这些事实，比较交给成本档。

### 交付读得更全，卡住的更少（0098、0101）

- `runs delivery` 与 MCP `run_delivery` 附 `adoption`：主分支上有没有提交以 `WAO-Adopted-From` 声明采纳了这个运行，三态呈现（0098）。
- 派发时声明 `verificationUnavailableReason`、原始验证为 unavailable、没有任何 reverify 事实的交付，Lead 审查后可以 accept；写门、恢复资格与已有决定的读面校验共用同一个谓词（0101）。

### 运行存放不再塌（0099、0100）

- 同一仓库的链接工作树算作主工作树的项目：从开发工作树派发的运行进主项目的桶，不再每棵树一个桶（0099）。
- 按 runId 查转录扫描全部项目桶、不设上限；桶目录超过 64 个时 `lead_preflight` 给一行事实，不再在上限处让追加与读取全部失败（0100）。

### 正确性

- 会进仓库的文本文件（已跟踪的，加上未跟踪且未忽略的）防控制字节与非 UTF-8（守卫 `controlBytes`）；脱敏守卫也扫同一范围，worker 还没提交的新文件在自检时就会被拦（0098 随批）。两处字面 NUL 改为转义；`runs delivery --wait-ms` 提前返回时写"returned early"，不再写"settled"。
- 诊断点名 deepseek-acp 的传输失败；MCP 服务的 build 检查只看 `src/`，改文档不再误报服务代码过期（0098）。

## 本次发版自带的变化

- package.json `version` 0.6.0 → 0.7.0。本周期新增了能力（`runs wait --until-settled`、`nextStep`、`adoption`、`videoInput`、派发回显车道事实），按决定 0038 第 1 条"新增能力升 MINOR，修复升 PATCH"升 MINOR。Owner 先提议 0.6.1；Lead 按这一条建议 0.7.0 并说明 PATCH 的发版门槛与 MINOR 相同，Owner 随后答"同意你推荐顺序"（推荐的顺序是先发 v0.7.0，2026-10-31）。README 双语徽章与新版说明指向本快照。

## reliability 豁免（Owner 具名，只对 v0.7.0）

- Owner 的答复（2026-10-31）：Lead 问"v0.7.0 的 deepseek-pro 那一行，是照跑还是豁免？"，Owner 答"允许deepseek-pro豁免"。
- 跳过的矩阵行：deepseek-pro（delta）。理由：该车道带 Owner 的暂停派发说明（"调试中，暂勿派发"），Lead 按它不派发该车道，探测也不派。
- 状态是"豁免"，不是"通过"；不常驻，不沿用到下一版。

## SSOT 核查（§9 第 0 步）

- Lead 扫描：按本周期改动过的事实与退役名搜索现行文档（等待窗口的下限与缺省、`--until-settled`、`verifier_gone`、桶数上限与解析降级、accept 的验证条件、`WAO-Adopted-From`、成本档与 Owner 规则、已退役名），并核对示例里的 agent id。没有查出漂移。
- 会审 consult_20261031073056878hsmxem（kimi、deepseek-flash，都判 FIX_FIRST）查出关键词扫不到的换说法漂移：
  - `docs/usage/supervise.md` 两处仍把会话绑定读工具的归属拒绝写成笼统的 `failed`；
  - `docs/usage/delivery.md` 写 `run_delivery_review_bundle` 的等待"readiness 稳定即提前返回"，0095 起按收口判定；
  - `SKILL.md` 写"一直调 `run_wait` 直到收口"，`run_wait` 只等到终态；
  - 收口定义里"终态后既无 created 也无 failed"缺"请求了交付"这个限定；
  - `docs/usage/delivery.md` 的"accept 仍须 passed"没有限定在 reverify 链上，0101 之后它不再是总规则；
  - 车道画像有两条选车道的 Owner 政策留在单车道注意事项里，0097 第 3 条要求只放 `ownerRules`；
  - 手册地图的 MCP↔CLI 表把 `run_status` 写成没有单一 CLI 等价、把交付审查写成 MCP 独有，与 `status`、`runs delivery review` 两页正文矛盾（早于本周期）；
  - README 双语示例 `runs delivery review` 缺必需的 `--file-index`（早于本周期）；
  - 本快照与 README 新版说明漏了 `run_delivery` 的等待变化、归属拒绝、`runs settle` 的扫描收紧与守卫范围，把 `--until-settled` 和 45 秒缺省说得过宽。
- 修复：以上各条都改了。为守住手册的字节上限，`docs/usage/delivery.md` 里讲转录绑定保护的一整段搬进 `docs/02-architecture.md` §4.7（它本来就是架构层的事实），手册留一句指针，没有抬上限。地图表的守卫期望同步改了配对。sol 的"会审查 bug 时优选"并入第 1 条 Owner 规则，"不必为省钱刻意避开 DeepSeek 高峰"并入"能省则省"那条，两条注意事项删掉，原话不变。
- 判为不改：会审另列了几处结构意见——项目身份规则在参考文档里没有一处完整的家、各页各写自己工具的等待缺省、`docs/usage/lanes.md` 的示例注册表键是形状示例、`docs/usage/consult.md` 用 `a,b` 作占位。它们与代码不矛盾，也不妨碍照做，留给以后的文档整理。
