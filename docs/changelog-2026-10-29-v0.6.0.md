# Changelog 2026-10-29 — v0.6.0 发版快照（v0.5.0 → v0.6.0）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-10-29。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`；发版动作：`docs/milestone-discipline.md` §9。
> 范围：tag `v0.5.0` → tag `v0.6.0`，决定 0084–0094。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。发版门槛证据在打标后追加于文末（§9 第 6 步）。

## 主题分组（按用户可感知的能力）

### 越界写拦得住，且有证明（0084、0086）

- 越界写拦截的认证改为组合证明：非 codex 车道活体演示它会如实报告自己的写入，确定性的链式测试证明七个有写事件投影的后端的越界帧都会被拦（0084）。替代了守约模型拒绝执行、无靶可拦的对抗演练。
- codex 车道每次调用都显式带 OS 写沙箱（workspace-write），认证改用参数钉与不经模型的沙箱执行检查来证明，取代上一条的活体演示（0086）。

### 隔离运行收得干净（0085），交付失败说得清

- 符合条件的隔离运行到终态即零丢失回收：只删干净的工作树，分支一律保留，有任何疑点就留树；会话复用、线系成员与已打包的交付不在其列（0085）。
- 交付重验证给 Lead 一次显式的第二次机会（attempt 2），从不自动重试；交付打包失败带安全的闭集错误类别，Lead 分得清是瞬时锁还是环境坏了。

### 车道画像：分项、有依据、以实测为准（0087–0090、0092）

- 车道画像改为分项打分，依据随格；车道换代即标待复核；`lead_preflight` 给出每条车道的分项评分与全部注意事项，带依据的完整画像在 `wao lanes`（0087–0089）。
- 车道怎么用只写在画像里：角色与流程文档不点车道名，会审副审来自不同族系（0090）。
- 实测结果可以覆盖 Owner 的手动评分，Owner 特别标注的除外（0092）；deepseek-flash、glm-flash 按同题横评重评，kimi 车道换到 K3.1 Pro。

### 宿主接入（0091）

- DeepSeek Harness（dsh）进宿主表：`wao mcp bind` 给出它的 profile patch 插入行，`wao mcp status` 探测 YAML 层（0091）。

### WAO 自己管好运行环境（0093）

- worker 运行、交付验证与全量测试期间，WAO 自己向 Windows 申请"系统与显示都需要"：屏幕不再因空闲熄灭，合盖也不进待机（实测插电 5 分钟、用电池 96 分钟）。这是尽力而为：申请起不来就不保持，用户自己选睡眠照样会睡（0093）。
- 提示词经标准输入交给 runner 与 codex/claude CLI，不再受命令行长度限制，交接带摘要校验与时限；MCP `run_delivery` 也给出验证闸的现状。

### 退役 workflow/DAG 层与 `wao state`（0094）

- 删除 DAG 引擎、`wao workflow run|list`、示例与模板、`wao state`，以及认证里的 workflow 演练。多步编排由 Lead 组合派发、会审与续接完成。
- 历史转录的读取保持兼容：存档里的旧 workflow 运行，用 `status --run-dir` 指向存档查，仍得到原来的状态；`.wao/state` 变为可选槽位。

### 安全与正确性

- 配置内容不再从解析错误里泄出，也不能在文本输出里伪造行；注册表条目自带的 id 不能冒充它的键；打印处统一转义错误输出。
- 只读的 git 调用不再改写索引；心跳新鲜度全仓一条规则；`wao doctor` 与派发的判定一致。
- `wao stop` / `run_stop` 经 kimi 自己的中止接口停 kimi-web 运行；什么都没停到的 stop 不再显示为已中止。
- 运行时升级（10-28 巡检）：claude-code 2.1.308、codex 0.165.0、kimi 2.4.0、DeepSeek Harness 0.2.1-rc.4、ZCode 3.16.3；会话复用演练在当天的 WAO 上重取证据。

## 本次发版自带的变化

- package.json `version` 0.5.0 → 0.6.0：本周期删除了命令（`wao workflow`、`wao state`），MCP `run_delivery` 的输出多了 `verificationGate`。删命令本属破坏性变更，按 0038 第 1 条的 0.x 宽限（1.0 之前允许在 MINOR 内做契约调整）升 MINOR。README 双语徽章与新版说明指向本快照。
- TD-294 了结：smoke 不覆盖的后端以该车道的 reliability 通过（或经 Owner 豁免）为真实运行时证据，sentinel 演练是其中一项，写进 `docs/milestone-discipline.md` §4，`docs/smoke-guide.md` 与 TD-16 同步。
- TD-273 了结为不清理：决定 0084 §4 规定以 adversarialEscape 为键的例外保持原样、历史不改写，新 case 不再生成该检查，例外影响不到新认证。

## reliability 豁免（Owner 具名，只对 v0.6.0）

- Owner 选定的答复（2026-10-29）：Lead 问"v0.6.0 豁免 deepseek-pro 一行吗"与"astra 照跑吗"，Owner 答"两个都同意"。
- 跳过的矩阵行：deepseek-pro（delta）。理由：该车道带 Owner 的暂停派发说明（"调试中，暂勿派发"；说明只提示、不拦截），Lead 按它不派发该车道，探测也不派。
- 状态是"豁免"，不是"通过"；不常驻，不沿用到下一版。
- 上一版的另一项豁免（delta 行的越界写对抗演练，TD-196）本版不需要：决定 0084 改用活体写入取证，本版各行全部通过。

## SSOT 核查（§9 第 0 步）

- 起因：Owner 把打标签的条件定为"所有SSOT文件/文档已正确反应最新版的事实"，随后要求"以后发布新版必须先检查SSOT"。本版据此在检查单加了第 0 步，并先对本版执行。
- Lead 扫描：按本周期改动过的事实与退役名搜索，并检查文档示例里的 CLI 命令与 agent id 是否存在。查出 `docs/usage/dispatch.md` 的 `spawn researcher`（7acf830）。
- 会审 consult_20261029184629633bgu4to（kimi、deepseek-flash，都判 FIX_FIRST）共列出 26 条，例如：
  - 检查单自身的证据组成漏了 codex 的沙箱分支；
  - 多处把"侦测、不是 OS 沙箱"写成所有车道；
  - 重验证仍写只能一次；
  - `persistent` 没写终态回收；
  - 验证闸少算一条路径；
  - 画像残留"替补"措辞；
  - 几处断锚与重复的事实。
- 修复：
  - glm-pro run_202610291903159811v1u4g 交付 38a0a70（30 个文件）。为守住字节上限，它删掉重复内容，没有抬上限；
  - Lead 补 cba4ac8 与 5e2eeda；
  - kimi 复核 consult_20261029201221822qegmj8，再复核 consult_20261029202735405bz8hta 判 PASS（其中一条判为误报：可披露工具是 6 个，去掉 run_collect 剩 5 个）。
  - 合入 main 为 cc11d2a。
- 顺序：第 0 步是在门槛第一轮之后才加入的。第一轮（全量、reliability、smoke、surface）跑在 6b976e1 上，全部通过。SSOT 修订改了文档，按 §9 第 8 步在最终提交 cc11d2a 上整轮重跑，下一节记的是重跑的结果。

## 发版门槛证据（2026-10-29，本地实跑；打标后追加）

- 全量 `npm test`：**349/349 通过**（6 波，674 秒，无隔离重跑，runs 守卫干净），跑在 tree 57b4ed8d 上，即 tag `v0.6.0` 指向的提交 cc11d2a。
- surface 再生成（§9 第 3 步）：在 cc11d2a 上重跑 `npm run gen:surface`，生成物与入库文件逐字节一致（`git status` 无改动）。
- `npm run reliability`：从主检出在 cc11d2a 上逐车道跑（`--agent <lane>`），本机注册表矩阵 8 行：
  - sol、astra（strict）：全过，certified。
  - kimi、glm-pro、glm-flash、deepseek-flash、opus（delta）：全过，评 conditional（delta 子集全过不产生 certified；按决定 0073 不适用的检查记 N/A，不算通过也不算失败）。
  - deepseek-pro：按上文豁免，未跑。
  - 矩阵原有 9 行，其中一行 glm-flash 是车道化前 researcher 席位遗留的重复行，首轮门槛里同一车道多跑了一遍。Owner 当场答"删掉"，本轮起只跑一遍。本机注册表不入库。
- `npm run smoke`：claude-code PASS，codex PASS，两条后端分别记录。smoke 不覆盖的后端，以上面各车道的 reliability 为真实运行时证据（§4 第 4 条）。
- 复现命令：`npm test`；`npm run reliability -- --agent <lane>`；`npm run smoke`；`npm run gen:surface`；`git diff --shortstat v0.5.0 v0.6.0`；`git rev-list --count v0.5.0..v0.6.0`。

## 总量

34 个提交，290 个文件，+20,762 / −6,410 行（`git diff --shortstat v0.5.0 v0.6.0`）。

## 发版记录

- tag：`v0.6.0`（annotated → cc11d2a，正文载门槛证据与 Owner 豁免原话）；推送顺序：先 main，后 tag。
