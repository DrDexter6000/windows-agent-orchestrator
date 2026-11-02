# Changelog 2026-11-02 — v0.8.0 发版快照（v0.7.0 → v0.8.0）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-11-02。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`；发版动作：`docs/milestone-discipline.md` §9。
> 范围：tag `v0.7.0` → tag `v0.8.0`：新决定 0102–0108，以及同期的修复与文档整理。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。发版门槛证据在打标后追加于文末（§9 第 6 步）。

## 主题分组（按用户可感知的能力）

### 接入与升级少些手工步骤（0107、0108）

- `wao skill link --host <host>` 默认只预览；加 `--apply` 后，在核实过的宿主技能槽位里建一个指向本检出的目录链接 `wao-orchestrator`。`skill unlink` 只摘指向本检出的链接。claude-code、codex、kimi-code 有核实槽位；zcode、opencode、claude-desktop、dsh 没有，只给一句按宿主文档安装的提示。doctor 报告每个槽位的状态；`install.ps1 -Uninstall` 删仓前先摘链接，摘不掉就中止（0107）。
- `wao registry align`：升级换了车道表里的型号或 effort 后，私有 `config/agents.json` 可以逐车道跟上。默认只读预览，给出文件的 SHA-256；`--apply` 必须点名车道并带 `--expect-sha256`，只改点名车道的四个接线轴和同名矩阵行的 `modelId`，写前逐字节备份。doctor 与 `lead_preflight` 报接线漂移；`lane_wiring_mismatch` 的拒绝写出两条出路（0108）。
- onboarding 写明升级与回滚。入口文档不再重复 onboarding 的步骤，各宿主的注册方法集中在 `docs/usage/host.md`。

### 只读运行默认写不到共享仓库，清退由 Lead 判定（0102、0103）

- 不复用会话的只读运行改在源仓的私有克隆里工作，默认作用于当前仓库的 git 写操作落在克隆里；席位显式写源仓路径或全局配置，克隆挡不住。删克隆前先查：有源仓缺的提交、HEAD 漂移、嵌套工作树或检查失败，都整个保留并记一条事件；未提交的改动与 stash 不保留（0102）。带 sessionReuse 的只读运行仍用链接工作树（TD-310 余项）。
- 清退计划由 Lead 逐项判定后直接 apply，事后向用户汇报；只有丢弃未提交内容和删除 bundle 要用户同意。规则只写在 `docs/02-architecture.md` §4.3「人工清退」（0103）。

### 两项退役（0105、0106）

- opencode worker 后端移出代码树，tag `archive/opencode-worker-backend` 保留最后状态；OpenCode 作为 MCP 宿主不受影响。恢复（`wao resume`）一律重放，`run_continue` 的会话续接不变。只探测 opencode-serve 的 `wao registry check` 随之退役，`registry validate` 保留其余检查（0105）。
- claude-code 的 provider 通道移出，tag `archive/claude-code-provider-channel` 保留最后状态。claude-code 只走原生 OAuth，带 provider 块的注册表条目一律拒绝。`providerKey` 字段保留、恒写 null，各车道指纹不变（0106）。

### 正确性

- `run_continue` 拒绝续接显式车道+角色派发的父运行时，MCP 拿到具名原因 `explicit_dispatch_continuable_unsupported`，不再是笼统错误（TD-327；MCP 工具面 +44 B，Owner 批准重冻）。别名运行续接后仍带车道与角色身份头（TD-328）。
- 持有验证租约的全量套件可以接管已证明死掉的套件留下的 inflight 标记；波次观测不再把自己的标记报成并发套件。
- `wao worktree remove` 只删链接工作树（按 git 的判定：目标是工作树的顶层，且有自己的私有 git 目录）：独立仓库（只读运行的私有克隆、主检出、`--separate-git-dir` 仓库）、子模块、工作树的子目录与普通目录一律拒删、不动盘。此前 git 拒绝时它会强删目录，不做任何检查。
- CLI 帮助列出每个已实现的子命令与参数，三个不存在的条目删掉，并有守卫保持代码与帮助一致。CLI 的三条等待路径不再把 `silentTimeout`、`tokenBudget`、`tokenBudgetMultiplier` 传进等待层：它们从来不是 CLI 参数，此前 `--token-budget 1000` 解析成字符串，遮住注册表里的数字，让预算检查静默失效。
- 车道画像：GLM 高峰只算工作日（北京时间 9:00–18:00），周末与中国法定节假日全天非高峰。

### 仓库自检与文档

- `npm run map` 打印仓库的引用图和每个文件的可达档位；守卫 `workflowReachability` 要求除几个约定文件（LICENSE、`.gitignore` 等）外，每个跟踪文件都能从入口文件经强边或中边到达。重复的决定编号被拒。
- SSOT 四原则的家是 `docs/ssot.md` §2（0104）。清掉孤儿文件；排障手册与交付页改正与代码矛盾的说法，复述的合同搬回架构文档；档案 README 成为历史记录的总入口。
- 开发改动的必读集合从约 172 KB 降到 48 KB，`docs/02-architecture.md` §0 新增按改动读的索引。
- 全量套件快约 55 秒：`cli.test.js` 拆成三个文件，工作区证明少调 git。

## 升级须知

- 注册表里 `backend` 为 `opencode-serve` 的条目、带 `provider` 块的条目，升级后不合法。删光之前：`registry validate` 逐条列出它们并 exit 1；读整表的严格命令遇到第一条就失败——`registry list`、`wao lanes`、`serve`、CLI `run`（派发哪条车道都一样）与 MCP 按车道+角色的派发；MCP `registry_list` 与 `lead_preflight` 照常列出合法条目，给坏条目附 issue。处理：删掉这些条目或改用现有后端；旧 claude-code provider 条目若还带 `model.contextWindow`，也要删掉（原生路径不支持）。要取回旧代码，用上面两个 archive tag，取回后补回测试并重新认证。
- `wao registry check` 已不存在，改用 `registry validate`。旧 opencode 运行的转录仍可 collect。
- 认证矩阵：`stop` 演练已退役，矩阵行里带它会报错，删掉即可；注册表没有 `certification.matrix` 行时不再有缺省矩阵，`npm run reliability` 解析出 0 个 case 即退出 2。
- 升级后跑一次 `npm run cli -- registry align`（零写入预览），看私有注册表是否落后于车道表；它只修接线，不替你删退役条目。
- 装技能改用 `skill link --host <host>`：先预览，再加 `--apply`。
- 认证台账里 `providerKey` 为非空字符串的旧记录不再匹配任何车道，要重新认证。

## 本次发版自带的变化

- package.json `version` 0.7.0 → 0.8.0。本周期新增了能力（`skill link`/`unlink`、`registry align`、`npm run map`、只读运行的私有克隆），按决定 0038 第 1 条升 MINOR；两项退役对旧配置是破坏性的，按同一条对 0.x 的宽限放在 MINOR 内，并在上面单列升级须知。Lead 建议 0.8.0，Owner 答"同意v0.8.0"（2026-11-02）。README 双语徽章与新版说明指向本快照。

## reliability 豁免（Owner 具名，只对 v0.8.0）

- Owner 的答复（2026-11-02）：Lead 问"deepseek-pro 那一行：照跑，还是豁免？"，Owner 答"deepseek-pro继续豁免"。
- 跳过的矩阵行：deepseek-pro（delta）。理由：该车道带 Owner 的暂停派发说明（"调试中，暂勿派发"），Lead 按它不派发该车道，探测也不派。
- 状态是"豁免"，不是"通过"；不常驻，不沿用到下一版。

## SSOT 核查（§9 第 0 步）

- 机械部分（main c243645 上）：`npm run map` 的"完全不可达""只经弱边可达"两栏为空；"只经中边可达"20 个，逐条过目，都是按目录或按文件名加载、设计如此：`docs/archive/` 的六份 m0–m5 审计稿（docs-consistency 按目录读）、`playbooks/lead/` 的四个 playbook（`playbookCatalog.js`）、`scripts/reliability/dsh-acp/evidence/` 的四份证据、`src/owner-dashboard/` 的两份静态资源、四个测试夹具与 helper。Lead 第一次看报告时截断了输出，记成 8 个；会审 deepseek-flash 实测指出是 20 个，Lead 已逐条补看。横切守卫组 228/228 通过。
- Lead 扫描：按本周期改动过的事实搜索现行文档——退役名（opencode / opencode-serve、provider 块、provider 通道、`apiKeyEnv`、`baseUrl`、`registry check`）与新事实（`skill link`/`unlink`、`registry align`、`npm run map`、`lane_wiring`、`explicit_dispatch_continuable_unsupported`、私有克隆），并核对示例里的 agent id。没有查出漂移：opencode 只剩 MCP 宿主与历史记录里的提法，`providerKey` 只作恒为 null 的身份字段出现。
- 会审 consult_20261102202642270kk3ydb（sol、deepseek-flash，都判 FIX_FIRST）查出关键词扫不到的问题：
  - `wao worktree remove` 在 git 拒绝时强删目录，私有克隆、主检出和普通目录都会被不经检查删掉；`docs/troubleshooting.md` §4.4 的清理步骤正指向它（deepseek-flash 在临时克隆里复现）。
  - README 双语把只读运行写成"碰不到共享仓库"，丢了 sessionReuse 例外与"默认"限定；本快照的 0102 一条漏了其余保留原因。
  - `docs/02-architecture.md` §4.2 把建树写在 `run.started` 之后，代码是先建树；resume 还写着"HTTP 类重新 attach 会话"，0105 起一律重放。
  - 架构 §2.3 与 `docs/usage/host.md` 把 `registry validate` 写成遇首条坏条目即抛错，代码是逐条汇总；本快照的升级须知跟着写错，也没说 CLI `run` 等严格命令会因任意一条退役条目整体失败。
  - 升级须知还漏了旧 provider 条目的 `model.contextWindow`、矩阵行里退役的 `stop` 演练与缺省矩阵的取消。
  - 本快照几处说过头或用词不准：等待层只剔除三个键；可达性守卫有约定文件豁免；"续接"应为恢复（resume）；没有核实槽位的宿主只给一句提示，不是逐宿主的步骤；README 的 inflight 接管漏了"持有验证租约"。
  - `docs/usage/lanes.md` 的"非默认 `--registry` 时车道表停用"没写 `registry align` 例外。
  - 本节"只经中边可达 8 个"有误（见上）。
- 修复：`wao worktree remove` 只删链接工作树，其余一律拒删、不动盘，并加了测试（去掉守卫即红）。`docs/usage/maintenance.md` 的私有克隆手工清理改用决定 0102 的判法：逐个到源仓查克隆里可达的提交，不按远程跟踪引用排除，0102 否决过那种判法。其余各条按代码改了；registry 严格路径的说明只留在架构 §2.3，`docs/usage/host.md` 改为指针。
- 判为不改：README 的新版说明是摘要，不单列 GLM 高峰的画像变化；把 map 计数做成生成物（deepseek-flash 的结构意见），本节记录的是一次核查的结果，不值得为它加生成层。
- 复核 consult_20261102211540961us7n81（sol、deepseek-flash，都判 FIX_FIRST）：上一轮的文档各条都已修对；守卫只看根目录下 `.git` 是不是文件，子模块、`--separate-git-dir` 仓库和带伪 `.git` 文件的目录仍会被放行删掉（两席各自在临时目录实测）。另指出 `src/runManager.js` 与 `src/registry.js` 各有一处注释还是旧说法，`docs/troubleshooting.md` §4.4 的清理步骤没提私有克隆，`docs/usage/maintenance.md` 的手工检查与 0102 并不同法（连 stash 也查、不查嵌套工作树），而且只看"没有输出"分不清干净与命令失败。修复：守卫改按 git 的判定，测试补上这三种形状；两处注释改成现状；§4.4 加一句指针；手工检查写成三项确认。
