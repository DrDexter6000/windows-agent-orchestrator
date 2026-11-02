# Changelog 2026-11-02 — v0.8.0 发版快照（v0.7.0 → v0.8.0）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-11-02。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`；发版动作：`docs/milestone-discipline.md` §9。
> 范围：tag `v0.7.0` → tag `v0.8.0`：新决定 0102–0108，以及同期的修复与文档整理。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。发版门槛证据在打标后追加于文末（§9 第 6 步）。

## 主题分组（按用户可感知的能力）

### 接入与升级少些手工步骤（0107、0108）

- `wao skill link --host <host>` 默认只预览；加 `--apply` 后，在核实过的宿主技能槽位里建一个指向本检出的目录链接 `wao-orchestrator`。`skill unlink` 只摘指向本检出的链接。claude-code、codex、kimi-code 有核实槽位；zcode、opencode、claude-desktop、dsh 没有，只打印手工步骤。doctor 报告每个槽位的状态；`install.ps1 -Uninstall` 删仓前先摘链接，摘不掉就中止（0107）。
- `wao registry align`：升级换了车道表里的型号或 effort 后，私有 `config/agents.json` 可以逐车道跟上。默认只读预览，给出文件的 SHA-256；`--apply` 必须点名车道并带 `--expect-sha256`，只改点名车道的四个接线轴和同名矩阵行的 `modelId`，写前逐字节备份。doctor 与 `lead_preflight` 报接线漂移；`lane_wiring_mismatch` 的拒绝写出两条出路（0108）。
- onboarding 写明升级与回滚。入口文档不再重复 onboarding 的步骤，各宿主的注册方法集中在 `docs/usage/host.md`。

### 只读运行碰不到共享仓库，清退由 Lead 判定（0102、0103）

- 不复用会话的只读运行改在源仓的私有克隆里工作，席位的 git 写操作只落在克隆里。删克隆前先查它有没有源仓缺的提交，有就整个保留并记一条事件（0102）。带 sessionReuse 的只读运行仍用链接工作树（TD-310 余项）。
- 清退计划由 Lead 逐项判定后直接 apply，事后向用户汇报；只有丢弃未提交内容和删除 bundle 要用户同意。规则只写在 `docs/02-architecture.md` §4.3「人工清退」（0103）。

### 两项退役（0105、0106）

- opencode worker 后端移出代码树，tag `archive/opencode-worker-backend` 保留最后状态；OpenCode 作为 MCP 宿主不受影响。续接一律重放。只探测 opencode-serve 的 `wao registry check` 随之退役，`registry validate` 保留其余检查（0105）。
- claude-code 的 provider 通道移出，tag `archive/claude-code-provider-channel` 保留最后状态。claude-code 只走原生 OAuth，带 provider 块的注册表条目一律拒绝。`providerKey` 字段保留、恒写 null，各车道指纹不变（0106）。

### 正确性

- `run_continue` 拒绝续接显式车道+角色派发的父运行时，MCP 拿到具名原因 `explicit_dispatch_continuable_unsupported`，不再是笼统错误（TD-327；MCP 工具面 +44 B，Owner 批准重冻）。别名运行续接后仍带车道与角色身份头（TD-328）。
- 持有验证租约的全量套件可以接管已证明死掉的套件留下的 inflight 标记；波次观测不再把自己的标记报成并发套件。
- CLI 帮助列出每个已实现的子命令与参数，三个不存在的条目删掉，并有守卫保持代码与帮助一致。CLI 不再把解析出的字符串参数传进等待层：此前 `--token-budget 1000` 会遮住注册表里的数字，让预算检查静默失效。
- 车道画像：GLM 高峰只算工作日（北京时间 9:00–18:00），周末与中国法定节假日全天非高峰。

### 仓库自检与文档

- `npm run map` 打印仓库的引用图和每个文件的可达档位；守卫 `workflowReachability` 要求每个跟踪文件都能从入口文件经强边或中边到达。重复的决定编号被拒。
- SSOT 四原则的家是 `docs/ssot.md` §2（0104）。清掉孤儿文件；排障手册与交付页改正与代码矛盾的说法，复述的合同搬回架构文档；档案 README 成为历史记录的总入口。
- 开发改动的必读集合从约 172 KB 降到 48 KB，`docs/02-architecture.md` §0 新增按改动读的索引。
- 全量套件快约 55 秒：`cli.test.js` 拆成三个文件，工作区证明少调 git。

## 升级须知

- 注册表里 `backend` 为 `opencode-serve` 的条目、带 `provider` 块的条目，升级后会被拒绝；`registry list` / `validate` 在第一条这样的条目处报错。删掉或改用现有后端。要取回旧代码，用上面两个 archive tag，取回后补回测试并重新认证。
- `wao registry check` 已不存在，改用 `registry validate`。
- 升级后跑一次 `npm run cli -- registry align`（零写入预览），看私有注册表是否落后于车道表。
- 装技能改用 `skill link --host <host>`：先预览，再加 `--apply`。
- 认证台账里 `providerKey` 为非空字符串的旧记录不再匹配任何车道，要重新认证。

## 本次发版自带的变化

- package.json `version` 0.7.0 → 0.8.0。本周期新增了能力（`skill link`/`unlink`、`registry align`、`npm run map`、只读运行的私有克隆），按决定 0038 第 1 条升 MINOR；两项退役对旧配置是破坏性的，按同一条对 0.x 的宽限放在 MINOR 内，并在上面单列升级须知。Lead 建议 0.8.0，Owner 答"同意v0.8.0"（2026-11-02）。README 双语徽章与新版说明指向本快照。

## reliability 豁免（Owner 具名，只对 v0.8.0）

- Owner 的答复（2026-11-02）：Lead 问"deepseek-pro 那一行：照跑，还是豁免？"，Owner 答"deepseek-pro继续豁免"。
- 跳过的矩阵行：deepseek-pro（delta）。理由：该车道带 Owner 的暂停派发说明（"调试中，暂勿派发"），Lead 按它不派发该车道，探测也不派。
- 状态是"豁免"，不是"通过"；不常驻，不沿用到下一版。

## SSOT 核查（§9 第 0 步）

- 机械部分（main c243645 上）：`npm run map` 的"完全不可达""只经弱边可达"两栏为空；"只经中边可达"8 个，逐条过目：`docs/archive/m0–m5-audit.md` 由 docs-consistency 按目录读，`playbooks/lead/` 的两个 playbook 由 `playbookCatalog.js` 按目录加载，都是设计如此。横切守卫组 228/228 通过。
- Lead 扫描：按本周期改动过的事实搜索现行文档——退役名（opencode / opencode-serve、provider 块、provider 通道、`apiKeyEnv`、`baseUrl`、`registry check`）与新事实（`skill link`/`unlink`、`registry align`、`npm run map`、`lane_wiring`、`explicit_dispatch_continuable_unsupported`、私有克隆），并核对示例里的 agent id。没有查出漂移：opencode 只剩 MCP 宿主与历史记录里的提法，`providerKey` 只作恒为 null 的身份字段出现。
