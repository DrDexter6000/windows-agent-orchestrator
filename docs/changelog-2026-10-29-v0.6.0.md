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
