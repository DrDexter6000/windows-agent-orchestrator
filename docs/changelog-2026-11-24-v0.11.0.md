# Changelog 2026-11-24 — v0.11.0 发版快照（v0.10.0 → v0.11.0）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-11-24。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`，0.x 的版本号映射与快照条款由 `.wao/decisions/0109-0x-version-bump-by-upgrade-action.md` 部分取代；发版动作：`docs/milestone-discipline.md` §9。
> 范围：tag `v0.10.0` → tag `v0.11.0`：第 122–138 批，决定 0127–0130（另有 0095 修订与 0021 追加）。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。发版门槛证据在打标后写入下文。

## 主题分组（按用户可感知的能力）

### MCP 工具面 20 → 17，CLI 退役两个入口

- `registry_list` 并进 `lead_preflight.workers`（同一条目 schema，补上 `cwd`、`sessionReuse`、`missingCredentialEnvNames`、`dispatchHold`，不设更紧的上限）；`runs_list` 并进 `lead_preflight` 的可选 `recentRuns`（`limit`、`activeOnly`）；`run_delivery_review_bundle` 删除，改为 `run_delivery` 加 `run_delivery_review` 两次调用（决定 0129，第 134 批）。
- `run_dispatch_contract_check` 保留：它的"只预检不派发"和 `availableProfiles` 在 MCP 面没有等价物；`run_dispatch` 另在派发时就地跑同一份预检。
- CLI `spawn` 与 `wao ask` 退役，敲旧命令给出替代写法；`run` 保留 `--scorecard-mode` 与 `--require-certified`（第 137d 批）。

### 少背几条规矩

- 续修的 `delivery` 可省，继承父运行已生效的交付合同；`delivery.mode` 缺省 `git_commit_v1`；八个写类 MCP 工具的 `expectedWorkspaceRoot` 在 schema 里标必填；暂存区有改动不再让打包失败（决定 0130，第 135 批）。
- 会审声明的字段是正式的结论通道，声明 Q1 时 WAO 自动追加格式行（决定 0128，第 131 批）。
- SKILL.md 是唯一入口，细节指向 `wao manual`（决定 0127，第 127 批）。

### CLI 补齐续修，回执带下一步事实

- `runs continue`、`runs correct`、`runs delivery repackage`：重新打包在 CLI 自己的进程里等验证跑完，不受 MCP 宿主约 60 秒的单次调用超时影响（第 137a 批，决定 0095 修订）。
- 等待与派发回执直接给出交付提交、改动文件与审查命令；MCP 回执附可直接用的 CLI 等待命令（第 136 批）。
- 回收判"近期活动"时不再算 Lead 自己的记账事件，裁决完可以当场回收（第 133 批）。

### 运行时适配

- kimi 2.7 适配：会话详情的 `activity`、执行中纠偏的新时序（第 128–130 批）；WAO 同时支持 kimi 2.6 与 2.7。
- 服务商额度失败在 zcode 车道快速收口，可靠性门遇到它不改认证台账（第 122 批，TD-359 关）；kimi-web 的 `provider.api_error` 能认出来（第 124 批）。
- codex 生图例外：只认已完成的补丁，失败的补丁不再记成写入（第 126 批，TD-357 关）。
- glm-pro 换到 GLM-5.4；巡检：claude-code 2.1.330、codex 0.171.0、dsh 0.2.2-rc.5、kimi 2.7.2、ZCode 3.19.1 与 4.0.0（11-20、11-21、11-22）；`npm run harness-inventory` 一条命令对照本机与最新版本，harness 改为用到才升级（第 138 批）。

### 文档与台账

- 使用手册与排障页瘦身（第 123、125 批）；台账里 46 条"等样本"逐条复审（第 138b 批）。

## 升级须知

- **要动手**：MCP 宿主重启，加载 17 个工具的服务端。调用过 `registry_list` 的改用 `lead_preflight` 的 `workers`；调用过 `runs_list` 的改用 `lead_preflight` 带 `recentRuns`；调用过 `run_delivery_review_bundle` 的改为 `run_delivery`（带 `waitMs`）再 `run_delivery_review`，并核对两次回执的 `deliveryCommit` 与 `changedFileCount` 一致。
- **要动手**：脚本里的 CLI `spawn` 改写：`spawn --wait` 改为前台 `run`；单个后台 agent 改为 `run --background`；多个 agent 改为每个 agent 一条 `run --background`，再 `runs wait <id1> <id2> ... --until-settled`。`wao ask` 改为 `run`，只读任务用 `run --read-only`。
- 写类 MCP 工具一律带 `expectedWorkspaceRoot`（此前处理器已必传，现在 schema 也标必填）。

## 本次发版自带的变化

- package.json `version` 0.10.0 → 0.11.0（MINOR：MCP 工具面删去三个工具、CLI 删去两个入口，宿主与脚本要改调用，决定 0109）。

## SSOT 核查（§9 第 0 步）

- 机械部分（main d3ea2fa8）：`npm run map` 的“完全不可达”“只经弱边可达”两栏为空；“只经中边可达”82 个，比 v0.10.0 多出的 35 个都是第 128–130 批按目录加载的 `test/fixtures/kimi-2.7.2/`，不是孤儿。横切守卫组在同一提交的全量里全过（376/376）。
- 人工判断：
  - consult_20261124065433147l49vee：原定 kimi 核第 122–132 批、deepseek-flash 核第 133–138 批；两席都核了第 122–132 批，都判 FIX_FIRST，必改项互相印证。同一份任务书按席位分工，席位并不知道自己是哪一席，上一版也这样漏过一段；以后每段单独一份任务书。
  - consult_20261124071915780en560k：补派 deepseek-flash 只核第 133–138 批，判 FIX_FIRST，必改 2 条、建议 11 条。
- 修复（本版发版提交）：
  - zcode 的快速失败收口（第 122 批，上游宣布本轮主轮请求不再重试时不等三道门）写进现行契约：架构 §2.5、排障 §6.9、监督页与派发页的摘要、`src/backends/factory.js` 的 vitalSigns（认证参考层随之再生成）；TD-359 归档行改为“宽限 5 秒、凭其后的快照收口”，与 21 秒实测一致。
  - 现状不再借已删工具描述：`lead_preflight` 的 `workers` 与 `recentRuns`（架构 §1、host 页、results 页）直接写字段与语义，不写“与原 `registry_list`/`runs_list` 同形”；架构 §1 工具表的完整清单指针改指 `docs/surface/mcp-tools.md`；冻结工具面条目里决定 0129 的经过收成指针（经过在决定档）。
  - `lead_preflight` 的工具描述不再叫宿主“用原工具复核”（原工具已删），改为看 `manualChecks`（`src/mcp/server.js`，surface 再生成；描述短了 6 字节，字节天花板未动）。
  - 会审页的 `nextStep` 写明 MCP 回执另带一条按 consultId 的 CLI 等待，与监督页一致（第 136 批）。
  - `run_dispatch_contract_check` 与 `run_dispatch` 改述为同源输入（这里 `expectedWorkspaceRoot` 可选；决定 0130 后 `run_dispatch` 必填），host 页的 `contract:"unknown"` 改为 `sections.contract`；`stagedResetPaths` 写明打包失败时也随 `run.delivery_failed` 落转录（架构、交付页）；交付页的 `contractAdvisories` 写明在派发受理回执里；`run_delivery` 的 `waitMs` 区间写进交付页，结束交付页与监督页互指却都没有数值的循环；TD-176 写明 auditor 无 verdict 拆到仍开放的 TD-180。
  - 其余：架构 §2.2 未定义的“N1”改写为“绝不伪造完成”；认证规程的画像复核写明决定 0128 的统计口径，`laneReviewStats.mjs` 注释随之改正；`consultService.js` 注释补上连字符；车道画像里两条统计证据标明是决定 0128 之前的口径。
- 判为不改：
  - 回收文档没列全 `running_now`/`undeterminable_now` 与不计近期活动的事件闭集：闭集以代码 `RECENT_ACTIVITY_IGNORED_EVENT_TYPES` 为准，手册余量 22 字节。
  - `run_continue` 继承合同复验失败的 `guidance` 字段只在决定 0130 与生成层：手册余量不够。
  - 认证规程 zcode 行没有 glm-pro 换型号后的认证记录：现行文档不写车道当前型号（docs-consistency 守卫），认证状态以认证台账为准，换型号的复核理由在车道画像 `reviewPending`。
  - 决定 0130 影响节写的是首轮交付的字节天花板：终值在 0021 追加记录；0130 已是 8176 / 8192 字节。
  - host 页与架构对就地预检、证据五列各有一段长文：留给下一次手册瘦身。
  - kimi 2.7.2 的 `activity` 在读取边界投影回 `busy`/`main_turn_active`、消息计数由 turns 页合成：行为不变，契约写的是 WAO 投影后的字段；架构余量不够再加说明，适配细节在认证规程 kimi-web 行与 `src/backends/kimiServeOps.js`。
  - 认证规程与车道画像 `reviewPending` 里的 harness 版本两处并存：`reviewPending` 是带日期的复核理由，不是版本事实的家。

## reliability 豁免（Owner 具名，只对 v0.11.0）

- deepseek-pro：仍挂着 Owner 的暂停派发说明（“调试中，暂勿派发”），本版未派发、未探测。Lead 问本版是否豁免，Owner 原话（2026-11-24）：“deepseek-pro可豁免”。
- 状态是“豁免”，不是“通过”；不常驻，不沿用到下一版。

## 发版门槛证据（2026-11-24，本地实跑）

- 全量 `npm test`：**376/376 通过**（6 波，1157 秒，其中 filesystem 波 750 秒；无隔离重跑，runs 守卫干净），跑在发版提交 f0408392 上，用电池（76%）。tag 指向的提交在它之上只加了本节（只改文档），按 `docs/testing.md` 只改文档那一行跑了横切守卫组。
- surface 再生成（§9 第 3 步）：在 f0408392 上重跑 `npm run gen:surface` 与 `npm run gen:certification`，生成物与入库文件逐字节一致。
- `npm run reliability`：从主检出在 f0408392 上逐车道跑（`--agent <lane>`，08:01–08:11Z）：
  - sol、astra：certified（full，含越界写被 OS 沙箱拒绝的检查）。
  - kimi、deepseek-flash、opus、fable、glm-flash、glm-pro：全过，评 conditional（delta 子集全过不产生 certified）。
  - deepseek-pro：按上文豁免，未跑。
- `npm run smoke`（主检出 f0408392，08:11Z）：claude-code PASS，codex PASS（回复 `smoke ok`）。smoke 不覆盖的后端，以上面各车道的 reliability 为真实运行时证据（`docs/milestone-discipline.md` §6.1）。
- 1.0.0 额外门槛（§9 第 7 步）：不适用，本版仍是 0.x；TD-194 未关。
- 复现命令：`npm test`；`npm run reliability -- --agent <lane>`；`npm run smoke`；`npm run gen:surface`；`npm run gen:certification`；`git diff --shortstat v0.10.0 v0.11.0`；`git rev-list --count v0.10.0..v0.11.0`。
