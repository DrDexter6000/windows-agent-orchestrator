# 0098 交付读面显示"有提交声明采纳了这个运行"：在主分支上找 WAO-Adopted-From，三态呈现

- 日期：2026-10-30
- 状态：accepted
- 来源：
  - 第 49 批 glm-pro 的交付（run_202610292137043231lt98j）验证失败，按"验证失败采纳协议"修后落地为 15494b9；转录里记的是 rejected，读面只显示 `Acceptance: rejected`，本周期两次有读者把它读成"被丢弃"。
  - Owner 2026-10-30 批准计划第 2 项（"修后采纳被记成拒收"的语义，先做方案会审），并同意本批的 MCP 工具面重冻（决定 0078）。
- 方案会审：opus、deepseek-flash（consult_20261030070501354y1u77i），两席都选"读时从 git 找"。
- 关系：不改决定链、acceptance 闭集与首决定胜；trailer 约定的家仍是 `docs/usage/delivery.md` 的验证失败采纳协议。

## 背景

- acceptance 是对"原样交付的那个提交"的裁决。修后采纳时 Lead 记 rejected，在落地提交里写 `WAO-Adopted-From: <runId>`（协议第 2 步）；找 trailer 要读者自己 grep。
- main 上有 21 个运行被 `WAO-Adopted-From` 引用：14 个记的是 rejected，7 个根本没有决定（如只有 `run.isolation_violation`）。决定事件写不进后者。
- git 自带的 trailer 解析认不出 15494b9 的两行 WAO trailer（其后空一行再接 `Co-Authored-By`，不在最后一段）；35fc0c5 只有 `WAO-Adopted-From`，没有 `WAO-Original-Delivery`。

## 决定

1. **读时从 git 找，不写转录。** MCP `run_delivery`（独立出参，不进 `run_delivery_review_bundle` 内嵌的 BASE）与 `wao runs delivery` 给每个运行加 `adoption`：`status` 为 `found`、`not_found` 或 `unchecked`；`commits` 为提交 sha 列表（上限 5，另有 `truncated`）；`uncheckedReason` 为 `unbound`、`no_main_branch`、`git_error`、`timeout` 之一，其余状态为 null。含义只是"主分支上有提交声明采纳了这个运行"，不是"已落地"，也不是"内容还在 HEAD 里"。
2. **在哪个仓库、哪条分支找。** MCP 用会话绑定的工作区根，未绑定就不跑 git，报 `unchecked`/`unbound`；CLI 用 `--cwd`（缺省与其他命令相同：`WAO_TARGET_CWD`，再当前目录）。分支是该仓库主工作树当前检出的分支，与 worktree reclaim 用同一个解析（抽成共享函数）；主工作树 detached 时报 `unchecked`/`no_main_branch`，不退回 HEAD，也不用 `--all`。
3. **不核验运行归属。** 查询只在调用方自己的仓库里按 runId 找提交，只返回提交 sha。动机实例的派发工作树已经删除，归属证明不了，核验会让它永远是 `unchecked`。runId 先过 `isValidRunId`。
4. **怎么匹配。** 用 `--fixed-strings --grep "WAO-Adopted-From: <runId>"` 预筛主分支全历史，再逐个取 `%B` 精确核对（不按交付的 base 收窄：base 常是开发分支上的提交，分支删除后会被 gc，收窄会让旧运行查不出；runId 带时间戳，不会早于运行就被引用）：CRLF 归一，容忍行尾空白，整行等于 `WAO-Adopted-From: <runId>`，所在段落每一行都是 `Key: value` 形。不要求 `WAO-Original-Delivery`。`runs verify-commit` 的 adoptedFromTrailer 改用同一个匹配函数。只读 git（`--no-optional-locks`、`gitChildEnv`、不 fetch），超时有界；失败只给闭集原因，不回显提交消息、路径或 stderr。
5. **等待路径只查一次。** `run_delivery` 带 `waitMs` 时，git 在返回前算一次，不进轮询。
6. **CLI 写法。** found：`Adopted in: <sha…> (WAO-Adopted-From on <branch>)`；not_found：`No WAO-Adopted-From trailer on <branch>`，acceptance 为 accepted 时不打这一行（accepted 交付本来不要求 trailer）；unchecked：`Adoption not checked (<reason>)`。没请求交付的运行谈不上采纳，只在 found 时打。
7. **文档。** 验证失败采纳协议写明：acceptance 是对原样提交的裁决，采纳的家是落地提交的 trailer；squash 时保留 trailer；trailer 写成 `Key: value` 成段。原第 2 步"已知审计面限制"的半句按现状改写。使用手册贴着字节帽，只替换不追加。

## 否决的备选

- **只补文档**：读面仍只显示 rejected，误读照旧。
- **决定事件加 disposition 或 adoptedCommit**：7 个无决定的采纳运行无处可写；转录与 git 两个家，还要先落地后记决定。
- **加第三个 acceptance 值**：所有 acceptance 消费者都要改；"验证失败也能进 adopted"会被读成门禁放宽。
- **只对 rejected 显示**：没有决定的采纳运行看不到。MCP 字段统一更简单，CLI 在 accepted 且没找到时不打行即可。
- **同时要求 `WAO-Original-Delivery`**：35fc0c5 只有 `WAO-Adopted-From`。
- **用 git 的 trailer 解析**：漏掉 15494b9。
- **从转录里的旧 cwd 上溯找仓库**：启发式，可能跨进无关的父仓库。

## 已知边界

- revert 提交不带 trailer：被 revert 的采纳仍显示 found。
- squash 丢了 trailer 就是 not_found；accepted 运行本来不要求 trailer，not_found 对它不说明任何事。
- 正文里出现与 trailer 完全同形的成段行仍会误中，不声称零假阳性。
- review bundle 不带这个字段（BASE 字节不变）；要带另议。
