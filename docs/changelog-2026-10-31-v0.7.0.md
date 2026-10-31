# Changelog 2026-10-31 — v0.7.0 发版快照（v0.6.0 → v0.7.0）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-10-31。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`；发版动作：`docs/milestone-discipline.md` §9。
> 范围：tag `v0.6.0` → tag `v0.7.0`，决定 0095–0101。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。发版门槛证据在打标后追加于文末（§9 第 6 步）。

## 主题分组（按用户可感知的能力）

### 运行收口时 Lead 会知道，不靠宿主推送（0095、0096）

- `wao runs wait <runId> --until-settled` 每 15 秒判定一次，运行、打包、验证与 reverify 都有结果才退出；没等到收口的等待、受理的后台派发都附一句 `nextStep`。MCP 的 `run_wait` 下限降到 30 秒，四个等待类工具缺省 45 秒，放得进约一分钟就让工具调用超时的宿主（0095）。
- 待验证的后台交付，等待器能证明验证进程已不在时以 `verifier_gone` 退出 3；会审回执与 `consult` CLI 说明怎么接着等没到终态的席位（0096）。

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

- 被跟踪的文本文件防控制字节与非 UTF-8（守卫 `controlBytes`），两处字面 NUL 改为转义；`runs delivery --wait-ms` 提前返回时写"returned early"，不再写"settled"。
- 诊断点名 deepseek-acp 的传输失败；MCP 服务的 build 检查只看 `src/`，改文档不再误报服务代码过期（0098）。

## 本次发版自带的变化

- package.json `version` 0.6.0 → 0.7.0。本周期新增了能力（`runs wait --until-settled`、`nextStep`、`adoption`、`videoInput`、派发回显车道事实），按决定 0038 第 1 条"新增能力升 MINOR，修复升 PATCH"升 MINOR。Owner 先提议 0.6.1；Lead 按这一条建议 0.7.0 并说明 PATCH 的发版门槛与 MINOR 相同，Owner 随后答"同意你推荐顺序"（推荐的顺序是先发 v0.7.0，2026-10-31）。README 双语徽章与新版说明指向本快照。

## reliability 豁免（Owner 具名，只对 v0.7.0）

- Owner 的答复（2026-10-31）：Lead 问"v0.7.0 的 deepseek-pro 那一行，是照跑还是豁免？"，Owner 答"允许deepseek-pro豁免"。
- 跳过的矩阵行：deepseek-pro（delta）。理由：该车道带 Owner 的暂停派发说明（"调试中，暂勿派发"），Lead 按它不派发该车道，探测也不派。
- 状态是"豁免"，不是"通过"；不常驻，不沿用到下一版。
