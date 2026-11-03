# Changelog 2026-11-03 — v0.8.1 发版快照（v0.8.0 → v0.8.1）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-11-03。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`，0.x 的版本号映射与快照条款由 `.wao/decisions/0109-0x-version-bump-by-upgrade-action.md` 部分取代；发版动作：`docs/milestone-discipline.md` §9。
> 范围：tag `v0.8.0` → tag `v0.8.1`：TD-332、b70 批（Lead 使用反馈）、决定 0109。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。发版门槛证据在打标后追加于文末（§9 第 6 步）。

## 主题分组（按用户可感知的能力）

### 边界由控制面给，不再靠任务书手写

- 只读运行（包括所有会审席）在 start 与 resume 时都在角色合同之前收到控制面的只读执行合同：不改项目文件（任务要求跑的测试与构建产生的报告和缓存除外），不对工作目录或任何已有检出跑写仓库的 git 命令，自己的实验只在系统临时目录下新建的目录里做，不读凭据、不打印环境变量，命令跑完再结束回合。交付合同补上工具写入只在工作树内（scratch 放 `.wao/runs/`，不是 OS 沙箱）、禁 git 写只管工作树与已有检出，并与只读合同共用凭据与收尾两条。两份合同都不进 `rolePin` 与 `roleSha256`。
- resume 从本运行绑定的 `run.read_only_declared` 认定只读，并在 `run.started` 记下的树里执行：复用会话的只读运行此前 resume 会跑回源仓。
- 会审席固定边界去掉"禁建文件"一句（文件边界由只读执行合同管）。"写文件即判 FAIL"此前按 `type: "file_written"` 计数，转录里实际是 `run.event` 带 `kind: "file_written"`，从没触发过。改为数只读观察投影里工作树内的写入：临时目录里的实验不算，也不掩盖同席在树内的写入；绝对路径按词法归一化，`<树>/./a.txt` 这类等价写法照样算。

### 会审等待与取原文

- `consult wait <consultId> --until-settled` 逐席等到每个已派发席位收口才返回，退出码与 `runs wait --until-settled` 同义；收口循环从 `src/commands/runs.js` 移到 `src/application/runSettlementWait.js`，两个命令共用。`consult show <consultId> --out-dir DIR` 把每席完整原文写成 `DIR/<agentId>.md`。CLI 回执的下一步提示改指 `consult wait <consultId> --until-settled`。

### 正确性

- 上了锁（`git worktree lock`）的工作树一律不删：`removeWorktree` 只强删 git 认得出、没上锁的链接工作树，交付释放、线系关闭与终态清理随之；`wao worktree remove` 拒删上锁的树并说明，按 git 登记的路径删，删后目录仍在就报错退出（TD-332）。`runs verify-commit` 的临时树改用同一个删树能力。
- codex 的 "Selected model is at capacity" 诊断为 `provider_capacity` / `overloaded`，此前落到 `evidence_passed_backend_failed`（TD-329）。

### 规则与文档

- 0.x 的版本号按升级要不要动手来定：要动手升 MINOR，向后兼容升 PATCH；每次发版一份快照（决定 0109，部分取代 0038）。
- `docs/testing.md`：最终全量之后只补改 `docs/**` 下的文档，跑横切守卫组和读这些文档的测试即可，不必重跑全量（角色合同、`SKILL.md` 这类会被注入或被测试钉住的 `.md` 不算）。
- 两条车道画像 caveat 改指控制面合同。

## 升级须知

- 不需要动手。新参数、新诊断码与控制面合同都是向后兼容的；手写在任务书里的只读与写入边界可以删掉；与合同一致的留着无害，与合同相反的任务书指令会被合同压过。MCP 宿主要重启才会跑到新代码（`lead_preflight` 的 server build 一行会提示）。

## 本次发版自带的变化

- package.json `version` 0.8.0 → 0.8.1。Owner 起初说"打个v0.8.1"；Lead 按 0038 第 1 条提议 v0.9.0，Owner 要求先审视版本规则（"你看我们最近一个月以来，每一次升级都是一个minor小版本的升级……"），看过 Lead 的提案后答"按此方案推进"，即决定 0109。按 0109 本周期只有向后兼容的改动，升 PATCH。README 双语徽章与新版说明指向本快照。

## reliability 豁免（Owner 具名，只对 v0.8.1）

- Owner 的答复（2026-11-03）：Lead 问"reliability 的 deepseek-pro 那一行：照跑，还是豁免？（豁免只管这一版，不沿用 v0.8.0 的）"，Owner 选"继续豁免"。
- 跳过的矩阵行：deepseek-pro（delta）。理由：该车道带 Owner 的暂停派发说明（"调试中，暂勿派发"），Lead 按它不派发该车道，探测也不派。
- 状态是"豁免"，不是"通过"；不常驻，不沿用到下一版。

## SSOT 核查（§9 第 0 步）

- 机械部分（main 4afbafc 上）：`npm run map` 的"完全不可达""只经弱边可达"两栏为空；"只经中边可达"20 个，与 v0.8.0 时同一批，都是按目录或按文件名加载、设计如此。横切守卫组 269/269 通过（含车道画像两项）。
- Lead 扫描：按本周期改动过的事实搜索现行文档（诊断码、会审等待、任务书条款、上锁的树）。查出两处：`docs/troubleshooting.md` §7.15 的 codex 已知案例没有"模型满载"这一条；`docs/usage/maintenance.md` 与 `docs/troubleshooting.md` 的清理步骤没说上锁的树不删。两处已补。
- 会审 consult_20261103135915164qvbkzn（sol、deepseek-flash，都判 FIX_FIRST）：决定 0109 的落点只做了一半。§9 前言、`docs/roadmap.md`、`docs/ssot.md` 与 §8 仍把版本规则整体归给 0038，照它们办事下一版会按旧规则升 MINOR；§9 第 1 步"其余消费者全派生"与第 2 步手改 README 相反。另指出：`docs/usage/dispatch.md` 的只读声明段与 `AGENT_ONBOARDING.md` 的 `--read-only` 说明没提只读执行合同；`SKILL.md` 只提画像数据的例外；`docs/testing.md` 的"唯一的例外"一句容易读成与补改例外矛盾；架构 §4.6 的临时目录例外漏了"仓库"；README 双语的"不改项目文件"漏了测试产物例外，"每个席位"应为已派发的席位；README 文档地图里手写的最新版本没有守卫钉住；0109 的"已有输出的含义变了"与"修复"有重叠区；本快照漏记席位固定边界与 CLI 回执提示的变化，几处说法不准。
- 修复：上述各处按代码与 0109 改正；README 文档地图改指档案门户的快照清单，不再手写最新版本；0109 补一句判据：判 MINOR 只看升级的人是否必须改配置、命令或做法，把错误的取值改对算修复。
- 判为不改：`runs verify-commit` 的测试在 sol 的沙箱里有三处超时与清理失败（Lead 本机以用户身份跑同一文件是绿的，见下文全量）；`consult wait` 的退出码在 consult 页与 supervise 页各列一遍（两处同义，consult 页写明同义）；MCP `run_consult` 回执里的 `readOnlyViolation` 在生成面看不到（生成层把嵌套字段展平，既有缺口）；"上锁的树不删"在架构、维护、排障三处各有一句，目前一致。
- 复核 consult_202611031421062449vlrp1（deepseek-flash，PASS_WITH_NOTES）：上一轮各项都已改对，横切守卫组 269/269。备注：档案门户的快照表没有守卫钉住，§9 第 2 步已补一句；README 的例外只写了测试，合同写的是测试与构建（README 是摘要，判为不改）。这一句是在全量之后补改的，只动 `docs/**`，按 `docs/testing.md` 跑了横切守卫组与读这份文档的测试（235/235）。
