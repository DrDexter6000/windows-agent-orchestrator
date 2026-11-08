# Changelog 2026-11-08 — v0.8.2 发版快照（v0.8.1 → v0.8.2）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-11-08。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`，0.x 的版本号映射与快照条款由 `.wao/decisions/0109-0x-version-bump-by-upgrade-action.md` 部分取代；发版动作：`docs/milestone-discipline.md` §9。
> 范围：tag `v0.8.1` → tag `v0.8.2`：第 71–86 批，决定 0110–0118。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。发版门槛证据在打标前写入下文。

## 主题分组（按用户可感知的能力）

### 窄缺陷交回原 worker，接回原会话

- 收口且未采纳的可续交付会说明：窄缺陷可用 MCP `run_continue` 交回同一 worker（决定 0112）。
- 续修接回原 provider 会话：谱系身份只来自谱系事实，车道加角色与别名派发都可续；续修轮各自报用量与缓存占比；claude-code 每会话一个配置目录（决定 0114，TD-333 关）。
- `runs delivery review <runId> --all [--out FILE]` 一次读完整份交付；`--since-parent` 只看续修轮相对已证明父交付的增量（决定 0116）。

### Lead 少跑几趟

- `lead_preflight` 列出等 Lead 处理的 open item（未决定的交付、未关闭的谱系、运行工作树等），按记录的项目身份认运行（决定 0113）。
- `wao manual <页> "<节>"` 在任何项目里按节读手册；手册页首的 `read_when` 是唯一来源（决定 0115）。
- `status --format line` 输出一行；`worktree reclaim` 打出可原样照抄的 apply 命令。

### 运行不再无声地死

- 长时间的 zcode 运行不再每拍留住一份会话快照：此前大会话的 runner 7–33 分钟撑满 Node 堆、无声退出，转录停在 running（第 84 批）。
- 子进程 stdin 写失败不再打死 runner（zcode、deepseek-acp、deepseek-harness、processBackend 的 correctable 分支）。
- `runs wait --until-settled` 能证明非终态运行已没有 runner 时退出 3 `runner_gone`，不再无限等。
- zcode 的 `session/messages` 轮询没应答的一拍按无进展计，不再 30 秒判失败（决定 0117，TD-335 关）。

### 正确性

- 本运行最后一条 `run.error` 是连不上上游（DNS、连接被拒或被断、超时、请求未发出）时诊断为 `provider_disconnect`。
- `runs lineage-close` 收到子运行 id 时关的是根运行的谱系（TD-338 关）。
- 运行不能证明属于目标工作区时，各工具给出带原因的拒绝，不再报笼统的 failed；`run_delivery` 即时查询在会话绑定时也核验归属（TD-324 关）。
- 链接工作树的 `.wao` 本地状态落主工作树（决定 0111）。
- 全量测试首轮更稳：回收测试的时钟每进程固定、场景仓退出即删（TD-130、TD-170、TD-181 并入 TD-194）。

### 规则与文档

- 只改文档的批次不跑全量，改跑横切守卫组与读这些文档的测试（决定 0110，角色合同除外）。
- 触及共享核心的 worker 交付验证改跑逐个列出的定向测试，公共夹具与测试运行器的改动仍跑全量；全量只在最终候选上跑一次（决定 0118，修订 0077 第 3 条）。
- 采纳协议补续修集成的取法；手册、认证表与五份决定的修订指针按第二轮 workflow 地图的会审结果改正（第 85 批）。

## 升级须知

- 不需要动手：新命令、新参数、新诊断类别与新的拒绝文案都向后兼容。MCP 宿主要重启才会加载新的服务端代码。
- 决定 0114 的已知边界：升级那一刻仍在跑的旧键续修，新的忙碌门看不到，对同一谱系再续修可能并发。升级前先等在跑的续修收口即可避开。

## 本次发版自带的变化

- package.json `version` 0.8.1 → 0.8.2（PATCH：本周期没有要用户改配置、命令或做法的变化，决定 0109）。

## reliability 豁免（Owner 具名，只对 v0.8.2）

- sol、astra（strict）：Owner 原话（2026-11-08）："说到跑可靠性门，sol和astra那边已经周额度用完了，所以这次可能它们两个车道通不过，可以豁免，请知悉"。理由：两条车道的周额度用完。
- deepseek-pro（delta）：Lead 问"可靠性门里的 deepseek-pro 那一行……v0.8.2 这一行是照样豁免，还是你想先解除暂停再跑？"，Owner 答"继续豁免"。理由：该车道带 Owner 的暂停派发说明（"调试中，暂勿派发"），不派发也不探测。
- 三行状态都是"豁免"，不是"通过"；不常驻，不沿用到下一版。

## SSOT 核查（§9 第 0 步）

- 机械部分（main cd069c7 上）：`npm run map` 的"完全不可达""只经弱边可达"两栏为空；"只经中边可达"20 个逐个过目：14 个是代码按目录或文件名加载的资产（playbook、看板页面、认证证据、测试夹具），6 个是经 docs-consistency 目录边可达的 `docs/archive/m0–m5-audit.md`，都不是孤儿。横切守卫组通过。
- 人工判断：workflow 地图第二轮。六条支线各一个只读 worker 走查 main cd069c7，402 条引句经脚本核对；Lead 合并出地图、11 条场景线与建议。会审 consult_20261108142341850czfiif（kimi、deepseek-flash、opus，三席都判 FIX_FIRST）查出地图自己的数字与命令错，以及七条建议与守卫或决定相反（`npm run mcp` 与 SKILL 的 1200000 句有守卫钉家、`lead_preflight` 描述字节冻结要 Owner 重冻、dsh-acp README 是带日期的证据记录、续修集成默认取累计的子交付等），已全部改正后才动仓库。
- 修复：第 85 批（9b0ffcc、6938479），以本周期改动过的事实为主：采纳协议补续修集成的取法；testing.md 的角色合同例外与全量耗时；手册不再照抄 `config/default.json`（旧副本缺两个键）、补 `runs lineage-close`、改掉两处旧平铺转录路径；SKILL 的转录位置；AGENTS 命令表；认证表的台账键说法改指 runbook（生成器模板改动并再生成）；`lineage-close` 不释放会话的说法统一到决定 0058；五份决定追加修订指针（0087 已到字节上限，指针留在 0097 的关系行）。会审 consult_20261108145345929fvzuon（deepseek-flash、opus，都判 FIX_FIRST，六项必改全收）；复核 consult_20261108151429093gluw73（opus，PASS_WITH_NOTES）。
- 判为不改或留到发版后：守卫钉住的投影与家（SKILL 的 1200000 句、`npm run mcp` 在入职手册 §4e）；isolation_failed 的三处陈述（契约、操作含义、现象→动作各在其家）；其余重复与缺口进台账 TD-344，runner 无声死亡进 TD-341，`runs settle` 位置参数进 TD-342，`lead_preflight` 描述补 open item 进 TD-343（要 Owner 批准工具面重冻）。worker 交付验证改为只跑定向测试：Owner 同意，写成决定 0118（修订 0077 第 3 条），随本版发布（第 86 批，只改文档）。

## 发版门槛证据（打标前写入）

（待填：全量、surface 再生成、reliability 逐车道、smoke）

## 总量

（待填：`git diff --shortstat v0.8.1 v0.8.2`、`git rev-list --count v0.8.1..v0.8.2`）

## 发版记录

（待填）
