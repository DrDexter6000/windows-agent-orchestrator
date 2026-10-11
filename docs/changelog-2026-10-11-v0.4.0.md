# Changelog 2026-10-11 — v0.4.0 发版快照（v0.2.0 → v0.4.0，含 v0.3.x 段指针）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-10-11。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`。
> 范围：tag `v0.2.0` → tag `v0.4.0`（d564d78）。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。
>
> **欠账承认（0038 纪律未落实段）**：0038 规定每次 MINOR/MAJOR 发版配一份 changelog 快照。v0.3.0（2026-10-05）与 v0.3.1（2026-10-07）未配（v0.3.1 属 PATCH，不在 0038 强制范围；v0.3.0 属欠账）。本文件**不事后补造**该段的门禁证据——v0.3.x 只给范围指针，其发版事实以 tag 与决定档为权威。自本快照起，README 版本徽章与 What's new 节版本由 `docs-consistency` 守卫钉到 package.json 单一来源（防再次漂移）。

## 总量

284 个提交，332 个文件，+42,826 / −2,425 行（`git diff v0.2.0..v0.4.0 --stat`）。

## 版本段指针（v0.3.x——无独立快照，指针不补造）

- **v0.3.0**（tag `v0.3.0`，2026-10-06，tag 提交 73d2118 时戳）：终局身份模型一步到位（决定 0045，决策窗口 2026-10-05）——车道/角色/别名三层模型、席位矩阵模型名化（0046 八车道键+别名表）、防向下派发双层（0047）、认证门禁与 effort 漂移门；切换窗口全程与终态台账见决定 0045 本档。
- **v0.3.1**（tag `v0.3.1`，2026-10-07）：TD 执行批四项（TD-223/220/219/221）落地 + 验收会审二轮六修（tag 注记为 Owner 发版 chore；细节以 tag 提交信息与对应决定档为准）。

## 主题分组（v0.4.0：决定 0048–0060，按用户可感知的能力）

### 生命周期与卫生收口（0056/0057/0058）

- **kimi serve 会话荚泄漏三层治理**（0056）：终态会话卫生（能力位 + 事件族）+ 验收线系释放 + `wao serve status|sweep|recycle` 手动维护族；上游缺陷已整理为 Owner 反馈包。
- **worktree 生命周期根修**（0057）：只读会审席位改 ephemeral、验收放树四道门、recycle 空壳清扫；`run.worktree_*` 事件族入 wire 冻结。
- **worker 私有 kimi 主目录**（0058，KIMI_CODE_HOME 阶梯②③④）与 **lineage-close 线系闭合出口**（0058）——分支永不删（0035 S5 偏离在案）。

### 正确性门（0051/0054/0055/0059）

- **run_consult 载荷合同**（0051）：MCP 面 capped 回执 + 按席分页无损重组（textSha256 页校验）；CLI 全文渲染不变。
- **干扰形登记册与自动裁定**（0054/0059）：套件自干扰可机器洗白（资格闭集 + 14 天衰减帽），史上首次真实洗白端到端钉在案；B2 回响死机制解除。
- **会审席位只读保规自动 FAIL**（0055）：会审 run 违规写注册表面自动翻红。

### 转录分桶与存量实迁（0060 / TD-190）

- 写侧分桶 `runs/projects/<slug>/` + 读侧三级解析链（D2-②b）；`runs migrate-projects` 迁移命令族（dry-run / --apply / --verify，manifest 台账）。
- **D3 存量实迁完成**：761 份迁移、4 份非终态保留、零冲突零失败零再现；`--verify` 全量 sha 对账通过；claims 91 守恒、总数 843 守恒。

### 交付收口与门禁可见性（0060 / TD-256）

- doctor 新检查 `wao_mcp_cert_gate_visibility`（恒 INFO advisory）+ 5b User 臂死臂修复 + 分作用域注册表读器。
- 6 棵 verification_failed 存量收账（decide rejected，MCP+CLI 双通道）；非交付树经 lineage-close 记账 + 证据门控释放处置。

### 摩擦与体验（0048/0052/0053）

- Lead 消费者摩擦处置三包（0048，TD-237/238/239 收口）；显式派发复用开门 + 失败即弃护栏（0052）；tester/coder 复用入册（0053，auditor 永不入）。

### 本次发版自带的变化

- package.json `version` 0.3.1 → 0.4.0（版本单一来源，CLI/MCP serverInfo/doctor 动态读）。
- 发版套件抓到 v0.3.0 时代 W1 绊线真红：`pkg.version.startsWith("0.3")` 在 0.4 断裂（313/314 stable_fail），修为语义化 `major===0 && minor>=3`（d564d78）。

## 发版门槛证据（2026-10-11，本地实跑）

- 全量 `npm test`：**314/314 通过**——发版冻结轮在最终提交 d564d78 上执行、绿后打标推送；同日 TD-256 批另有迁移前后两轮 314/314。首轮发版套件 313/314 的唯一失败即上述 W1 绊线（stable_fail），修复提交即 d564d78 本身。
- `npm run cli -- wao doctor`：三份安装形态在场、版本一致（0.4.0）。
- 全量 `npm run reliability` **未在发版日重跑——此为 0038 发布门槛的缺项登记，不是豁免**（本发版周期无 completion 判定/provider 错误处理类改动，未触发 milestone-discipline §6.7 类硬门槛；无具名 Owner 豁免记录；席位级 delta/复验记录在各决定档，如实列出，不包装为完整门槛证据）。
- 复现命令：`npm test`；`git diff v0.2.0..v0.4.0 --stat`；`git rev-list v0.2.0..v0.4.0 --count`；`npm run cli -- wao doctor`；`git tag -l v0.4.0`。

## 发版记录

- tag：`v0.4.0`（annotated → d564d78）→ 已推远端（main 同步）。

## 勘误（2026-10-11 晚追加，0062 批；本文件只追加不回改，以上原文保留原样）

- **"发版门槛证据"节的这句陈述不实**：原文称"本发版周期无 completion 判定/provider 错误处理类改动，未触发 milestone-discipline §6.7 类硬门槛"。核对 `git log v0.3.1..v0.4.0`：`77efe1b`（zcode 完成判据/证据台账改身份切片——完成判定类改动）在周期内，`src/backends/` 六文件增删 +636/−105 行。**事实是：§6.7 的 PR 级触发条件当时已触发；规定的 `npm run reliability` 未执行；当时实际做的是 live 探针验证（`.dev/bprime-evidence/`），§6.7 不承认探针可以替代 reliability；没有具名 Owner 豁免——缺项始终未满足**。缺项登记的结论（reliability 未跑）不变，"未触发"归因撤回。（初版勘误曾把 `ccdaadd` 也列为完成判定改动——该提交标题明写"完成路径正文/证据发射**不变**"，属节流 streaming 呈现改动，此引不实，双席审核抓出后于提交前修正。）发版检查单（milestone-discipline §9，0062）此后要求如实区分"通过/未完成/豁免"三态。
- **v0.3.0/v0.3.1 为轻量 tag**（`git cat-file -t` 返回 `commit`，非 `tag` 对象），违反 0038 Consequences 的 annotated 要求（v0.1.0/v0.2.0/v0.4.0 均合规）。只登记不重打——重打会改变已发布的 tag 对象。发版检查单（0062 §9 第 9 步）以此为先例钉死 annotated 形。
