# Changelog 2026-11-20 — v0.10.0 发版快照（v0.9.0 → v0.10.0）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-11-20。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`，0.x 的版本号映射与快照条款由 `.wao/decisions/0109-0x-version-bump-by-upgrade-action.md` 部分取代；发版动作：`docs/milestone-discipline.md` §9。
> 范围：tag `v0.9.0` → tag `v0.10.0`：第 104–121 批，决定 0124–0126（另有 0021 追加）。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。发版门槛证据在打标后写入下文。

## 主题分组（按用户可感知的能力）

### MCP 工具面 23 → 20

- 跨调用共享的项目选择删除：`workspace_select` 与 `workspace_status` 撤出，调用目标由每次调用的 `expectedWorkspaceRoot` 给出；写类工具必传，读类工具可选、只作用于本次调用（决定 0125，第 118、119 批）。
- MCP `run_wait` 撤出：等终态用重复 `run_await_result`，等交付收口用 `run_delivery` 带 `waitMs`，挂到收口用 CLI `runs wait --until-settled`。`lead_preflight` 改收 `expectedWorkspaceRoot`。

### 续修谱系收尾少十来个动作

- 采纳了续修谱系的最终候选后，沿已证明续修父边的祖先由谱系派生为"被取代"（`supersededByRunId`），不写事件，不用再逐条拒收；`lead_preflight` 不再催它们，回收直接摘树（决定 0126，第 120 批，TD-353 关）。
- `wao worktree reclaim` 随之收紧：只靠路径声明的成员、内容冲突的孪生、空转录的分支、存储读不全时的整份计划、执行时仍在跑的分支，都改为保留或跳过。
- 多目标 `runs wait <runId>... --until-settled`：先到先返回，给出重挂命令（第 118 批）。

### 续修轮看得到新合同

- claude-code 与 codex 的续修轮把本轮角色与交付合同以 `[WAO control plane]` 重述在提示词前（两者 resume 时都沿用建会话时的系统指令），首轮合同预授权这种重述（第 110 批，TD-352 关）。

### 等待与收口

- 收口等待证明不了 runner 已不在时，以退出码 5 `runner_unproven` 报警；开机事实只陈述、不放行（决定 0124，第 107 批）。
- `delivery.allowedPaths` 拒收 `*` 与 `?`：目录写裸路径；已持久化的合同照旧（第 108 批）。

### 运行时适配

- ZCode 3.18 的消息与片段身份字段改名，两种拼写都认（第 104 批）；装机 ZCode 3.18.2。
- kimi 2.6 适配：turns 端点，纠偏打断原轮另开新轮（第 109 批）。本版 WAO 只能驱动 kimi ≥2.6。
- sol、astra 换代到 `gpt-6.2-sol`、`gpt-6.2-astra`（第 111、112 批）；codex 0.170.0、claude-code 2.1.326（11-17、11-18 巡检）。

### 车道

- 写代码按阶梯选车道：glm-pro（GLM 高峰 glm-flash）→ deepseek-flash → opus，跳级写理由（Owner 规则 3、4，第 114 批）。
- 写代码与会审两格改用真实交付与会审统计（第 115–117 批，`npm run lane-review-stats`）；fable 解除待复核（第 121 批）。

### 正确性与测试

- 入口判断统一到 `src/entryPoint.js`（第 106 批）；交付证明合并相邻只读 git 查询（第 105 批）。
- Owner 看板选中终态运行不再无限重取（第 118 批）；看板的全面改造另立专题（TD-355）。

## 升级须知

- **要动手**：MCP 宿主重启，加载 20 个工具的服务端。调用过 `workspace_select`、`workspace_status` 或 MCP `run_wait` 的宿主提示与脚本，改成每次调用带 `expectedWorkspaceRoot`，等待改用上面三种方式。
- **要动手**：kimi-web 车道要 kimi 2.6 或更新（`kimi upgrade -y`）。
- **要动手**：注册表里 sol、astra 的模型改为 `gpt-6.2-sol`、`gpt-6.2-astra`（`wao registry align`，决定 0108）。
- `delivery.allowedPaths` 里写过 `tests/**` 这类通配的，改成裸目录路径 `tests`。

## 本次发版自带的变化

- package.json `version` 0.9.0 → 0.10.0（MINOR：MCP 工具面删去三个工具，宿主要改调用；kimi-web 要 kimi ≥2.6，决定 0109）。

## SSOT 核查（§9 第 0 步）

- 机械部分（main e49c0b47）：`npm run map` 的“完全不可达”“只经弱边可达”两栏为空；“只经中边可达”47 个，比 v0.9.0 多出的 27 个都是第 109 批按目录加载的 `test/fixtures/kimi-2.6.3/`，不是孤儿。横切守卫组在同一提交的全量里全过（374/374）。
- 人工判断：
  - consult_20261120062333219c5exzw：原定 deepseek-flash 核第 104–113 批、opus 核第 114–121 批，deepseek-flash 误核了后一段，于是两席都核的第 114–121 批，都判 FIX_FIRST，发现互相印证。
  - consult_20261120063920525cxdiri：补派 deepseek-flash 核第 104–113 批，判 PASS_WITH_NOTES，13 条都是建议。
- 修复（本版发版提交）：
  - 手册：`runs_list` 的输入改为三字段、写明未绑定时返回固定错误；`run_stop` 的输入补上 `expectedWorkspaceRoot`；派发页删去已撤的“会话选择”；`nextStep` 写明 MCP 面只有 `run_dispatch`、`run_delivery`、`run_consult` 带、`run_await_result` 不带；“会话绑定”统一为“缺省绑定”；`run_await_result` 与 CLI `runs wait` 的窗口区间和缺省写在监督页一处，几处“见生成层”的空指针改指它；zcode 宿主超时的等待族补上带 `waitMs` 的 `run_delivery`；收口等待 30 分钟写明起算点；kimi-web 车道写明要 kimi 2.6 或更新（安装页、onboarding）。
  - 架构：四值活性投影的家改写为 `runWait.js#summarizeLiveness`，`ownerLiveness.js` 只是心跳新鲜度；§4.9 补派生被取代的契约（决定 0126），交付页的派生条件收成指针；删去“v0.10.0 起”“此后不再承诺”这类改动史；allowedPaths 的拒绝码与验证声明的拒绝码分开写；为守住字节上限，删去两处设计理由与一处常量数值。
  - 认证规程：解除待复核的例外删去不存在的“GLM 车道不做把关”规则示例；deepseek-acp 行的 dist-tag 值只留在实测格。
  - 其余：排障页补退出码 5 的症状入口，zcode 流分片写明 3.18.x 未复测；team-roles 写明读类工具可按调用带根；TD-339 改述规则形状；kimi 的 reviewPending 补回“conditional”；`src/mcp/server.js` 一处注释改为缺省绑定。
- 判为不改：
  - 交付页 4b 补 allowedPaths 写法的指针（手册余量不够；规则在架构 §4.7，派发前检查与 `run_dispatch` 已给固定规则句）；
  - 第 110 批补决定档（重述合同是 TD-352 的修复，没有备选取舍，经过在提交说明）；
  - TD-199 是否已有样本（要读真实运行，另行核对）；
  - TD-194 补测试指针（行长上限）；
  - 会话复用 drill 的 astra 型号与证据（重跑要真实 token，下次巡检时做）；
  - 车道画像的证据指向本地档案、Owner 定的星级补备注（数据都在提交说明里）；
  - 架构 §1 角色合同段补续修重述指针（架构余量为 0）。
- 两处余量：本版合入后架构 133,000 / 133,000、整本手册 226,292 / 226,300。

## reliability 豁免（Owner 具名，只对 v0.10.0）

- deepseek-pro（delta）、glm-flash（delta）、glm-pro（delta）：
  - deepseek-pro 仍挂着 Owner 的暂停派发说明（“调试中，暂勿派发”），本版未派发、未探测。
  - glm-flash、glm-pro 在 97685da4 上跑过，两轮都在派发子进程超时后记为 rejected。原因是 GLM 周额度用尽：服务商返回 429，代码 1310，限额 2026-11-21 06:35Z 重置（ZCode CLI 日志 `model.request.failed` 原文）。WAO 没有把这种失败认成服务商额度问题，另记 TD-359。
  - Lead 报告 GLM 额度要到次日早上才恢复、deepseek-pro 待点名后，Owner 原话：“我不能干等一天，在明早GLM额度恢复之前，我可以给GLM、deepseek-pro车道也给豁免，我们把其它可以做的事先做起来”。
- 状态是“豁免”，不是“通过”；不常驻，不沿用到下一版。
- glm-flash、glm-pro 在认证台账里仍是 rejected，认证门拒派这两条车道；额度恢复后 Lead 重跑恢复派发资格，结果追加在本文件。

## 发版门槛证据（2026-11-20，本地实跑）

- 全量 `npm test`：**374/374 通过**（6 波，816 秒，其中 filesystem 波 469 秒；无隔离重跑，runs 守卫干净），跑在发版提交 97685da4 上，插电。tag 指向的提交在它之上只加了本节、豁免节与 TD-359 一行（只改文档），按 `docs/testing.md` 只改文档那一行跑了横切守卫组与读这些文档的测试。
- surface 再生成（§9 第 3 步）：在 97685da4 上重跑 `npm run gen:surface`，生成物与入库文件逐字节一致。
- `npm run reliability`：从主检出在 97685da4 上逐车道跑（`--agent <lane>`，07:16–07:56Z）：
  - sol、astra：certified（full，含越界写被 OS 沙箱拒绝的检查）。
  - kimi、deepseek-flash、opus、fable：全过，评 conditional（delta 子集全过不产生 certified）。
  - glm-flash、glm-pro：rejected，按上文豁免。
  - deepseek-pro：按上文豁免，未跑。
- `npm run smoke`（主检出 97685da4，08:01Z）：claude-code PASS，codex PASS（回复 `smoke ok`）。smoke 不覆盖的后端，以上面各车道的 reliability 为真实运行时证据（`docs/milestone-discipline.md` §6.1）。
- 1.0.0 额外门槛（§9 第 7 步）：不适用，本版仍是 0.x；TD-194 未关。
- 复现命令：`npm test`；`npm run reliability -- --agent <lane>`；`npm run smoke`；`npm run gen:surface`；`git diff --shortstat v0.9.0 v0.10.0`；`git rev-list --count v0.9.0..v0.10.0`。

## 总量与发版记录

打标后追加。
