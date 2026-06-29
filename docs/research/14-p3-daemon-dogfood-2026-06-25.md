# 14 · P3 daemon e2e dogfood 审计（2026-06-25）

> 类别：**过程（Process Log）**，时间冻结快照。记录 P3-T1 daemon 落地后的 lead-agent 视角
> e2e dogfood 发现的 friction。修复状态/进度不在本文维护——指针指向 `docs/tech-debt.md`（TD 编号）
> 或后续 phase。不复制状态机/接口契约（权威在 `docs/02-architecture.md`）。
>
> 背景：P3-T1 标"手验 ✅"实为**机械 smoke**（daemon 进程 start/ping/list/stop 能跑）。
> 本 dogfood 是补做的真 agent 视角端到端审视——坐进安装 WAO 的 agent 椅子，从 SKILL.md daemon
> 章节读起实操，用真实 worker（非 sentinel）验证文档→workflow→工具的合理性。
>
> 对照前序 dogfood：[research/11](./11-e2e-lead-dogfood-audit-2026-06-25.md)（F0-F6+N1-N5）、
> [research/12](./12-p0-realtask-dogfood-2026-06-25.md)（P0-F1..F4）。本文 friction 以 D- 前缀。

## D-F1 · daemon 缺"派发 worker"的 CLI 入口（严重，功能缺口）

> **✅ 已修（2026-06-25）**：新增 CLI `daemon run <agentId> --prompt ...`（`src/cli.js daemonRunCommand`），
> 经命名管道发 `{cmd:"start"}` 给 daemon，run 由 daemon 持有 → 出现在 `daemon list`（解 D-F1 + D-F2 可见性）。
> 2 红绿测试 + 真实 smoke（coder_low 经 daemon 派发 → 25s 到 completed → collect 拿到 worker 产出 "DF1_OK"）。
> **顺带澄清**：初版 smoke 误判 daemon run "卡 submitted"——实为等待不足（claude-code 启动开销 ~20s），
> 非 bug；25s 后正常 completed。SKILL.md 已更新推荐 daemon run 而非 run --background（统一视图）。

**现象**：daemon 进程的 IPC `start` handler 已实现（`src/daemon.js` handleRequest，能派发 worker 驱动
waitForCompletion），但 **CLI `daemon` 命令族没有对应入口**——只有 `start(进程)/stop/status/list/ping`，
没有 `daemon run <agent>` 或 `daemon start <agent> <prompt>`。

**agent 实操体验**：
> 我 `daemon start` 起了 daemon，然后想让它帮我跑一个 researcher——但没命令。
> 只能回去用 `run --background`（P2 路径，不经 daemon）。那 daemon 存在的意义是什么？

**根因**：P3-T1 把 daemon 的 IPC `start` handler 实现了，但**漏了 CLI bridge**——daemon 能派发，agent 却
够不到这个能力。IPC handler 孤立存在。

**性质**：真实功能缺口，非 polish。daemon 当前**实际可用价值接近零**（能起能 ping，但不能派发；
P2 派发的它又看不到，见 D-F2）。

**实证**：`node src/cli.js daemon run researcher --prompt "test"` → `Unknown daemon subcommand: run`。

## D-F2 · daemon 与 `--background` 是两套隔离的所有者，无统一视图（设计割裂）

> **✅ 可见性已补（2026-06-26）**：daemon `list` 改为扫 runDir 全部非终态 run 并按 owner 分类
> （`daemon` / `external` / `orphan`）——`external` = 有活 owner 文件（D-F3 `.owner-<runId>`）但不在
> daemon 内存，即 P2 `--background` runner 在驱动的 run。现在 lead 在一处看到所有在飞的 run。
> 新增 `src/daemon.js` 纯函数 `scanAllRuns`，8 红绿测试 + 真实 smoke（daemon-owned + external 同列）。
> **不彻底**：这只是**可见性统一**，未动两套所有者模型——彻底统一（让 `--background` 注册到 daemon /
> 废弃其一）仍是 P4 范围的设计决策（见 `docs/archive/m7-phases.md` P4、handoff §5）。forward-compatible：
> 不删任何路径，P4 如何定都不返工。

**现象**：`run/spawn --background`（P2）派发的 run **不出现在 daemon 的 list 里**。两条路径完全隔离。

**agent 实操体验**：
> 我用 `run --background` 派了 coder_low，`daemon list` 看不到它。我到底该用哪个？
> daemon 管的 run 和 background runner 管的 run 是两个世界，我作为 lead 无法在一个地方看到所有在飞的 run。

**根因**：daemon 和 background runner 是两套并行的"生命周期所有者"，各自持自己的 RunManager + Map，
没有共享的 run 注册表。SKILL.md:140-141 说"两条路径同一安全属性"，但没说**它们互相不可见**。

**性质**：架构语义问题。短期可接受（都安全），但 lead 视角的统一视图缺失是真实 friction。

**实证**：`spawn coder_low --background` 后 `daemon list` → `{"runs":[]}`（P2 run 不在 daemon 视图）。

## D-F3 · `--resume-on-start` 接管 P2 残留 run 会双所有者竞态（D-F2 的危险面）

> **✅ 已修（2026-06-25）**：ownership 心跳判活，弃用 staleness 启发式。
> - 新增 `src/daemon.js` 纯函数 `isRunOwned` / `ownerFilePath`；`scanResumableRuns` 加 ownership 过滤
>   （有活 owner 的 run 不 resume，防劫持）。
> - 改 `src/backgroundRunner.js`：P2 runner 启动写 `.owner-<runId>` {pid, heartbeatAt}，存活期间
>   周期更新心跳，`finally` 删。daemon resume 前查 owner 活则 skip。
> - **关键设计取舍（owner 教训驱动）**：原考虑 staleness guard（事件时间判活），被 owner 否决——
>   RunMaestro 经验证明对长任务（全量 CI 40min 沉默）会误判活 run 为孤儿去 resume，**正好重蹈 D-F3**。
>   ownership 心跳是确定性的（直接反映 owner 进程生命体征，不依赖 run 输出节奏），符合教训。
> - 7 红绿测试。真实 smoke 复现：P2 `--background` + 立即 `daemon --resume-on-start` → owner 文件新鲜 →
>   **daemon list 空（不被劫持）**；P2 run 独立完成，owner 文件清理。对比修复前：同场景 daemon list
>   会显示该 run（state=submitted，双所有者竞态）。

**现象**：`daemon start --resume-on-start` 扫 runDir 非终态 run 并 resume——但它**假设 run 是孤儿**
（原所有者死了）。如果 P2 的 background runner **还活着**，会出现两个进程同时驱动同一个 run 的竞态。

**实证（修复前）**：P2 `spawn coder_low --background` 后立即 `daemon start --resume-on-start` → daemon list 显示
该 run（state=submitted，被 resume 接管），但 run 最终仍卡 submitted（双驱动竞态，P2 runner 还在跑）。

**根因**：`scanResumableRuns`（`src/daemon.js`）只看 transcript 状态，不判"是否已有活的所有者"。
daemon 无法知道一个 running 态 run 是不是 P2 runner 还在管。

**性质**：真实竞态 bug，但只在"P2 + daemon 混用 + resume"路径触发。红绿测试用 mock fetch 暴露不了
（mock 立即终态，不卡 submitted）。**这正是 dogfood 相对单测的价值**。

## D-F4 · handshake 在 `runs/daemon.json`，与 agent 心智模型不符（对应 owner 决策点）

> **✅ 已定（2026-06-25）**：owner 选**方案 D 融合**——但落地时发现独立指针文件无合适槽位
> （5 槽位锁死，project.md 是纯静态），**真正的 D = SKILL+CLI 即指针，不碰 `.wao/`**。
> D-F4 的本质是 agent 直觉去 `.wao/` 扑空——但 agent 与 WAO 的契约本就是经 CLI 不翻原始文件。
> 解法：SKILL.md daemon 段明确"**查 daemon 状态用 `daemon ping`/`daemon list`，不查 `.wao/`**"，
> 并固化"`.wao/` 不存运行时状态"约定。daemon.json + .owner-<runId> 都留 runDir（运行时状态集中一处，
> 不分裂）。**不改槽位数、不破守卫、零代码逻辑变更**（纯文档纠正 agent 直觉 + docs-consistency 守卫固化）。

**现象**：daemon handshake（pid/pipe/心跳）在 `runs/daemon.json`，与 run transcript 混在一起。
agent 诊断 daemon 状态时**直觉去 `.wao/`**（项目状态家）找，扑空。

**agent 实操体验**：
> daemon 卡了，我想手动清理 pid。直觉去 `.wao/`（那是项目状态的家）——没有 daemon 相关。
> 实际得去 `runs/daemon.json`。handshake 位置和我的心智模型对不上。

**根因**：P3-T1 选 runDir 的理由是"避 5 槽位守卫"（规避障碍），非"最优设计"。`.wao/` 定位是
"项目状态外化的物理基础"（`waoDir.js:4`），daemon 进程状态语义上属运行时状态，归 `.wao/` 更纯。

**爆炸半径**（[research 探查]）：扩 `.wao/` 到 6 槽位（`runtime/`）需同步改 9 契约面 + 2 守卫测试
（`waoDir.js`+4 注释、`test/waoDir.test.js:109` 硬编码 `===5`、`test/waoLayout.test.js` dogfood 守卫、
`cli.js:1203` 第二硬编码槽位列表、`daemon.js` 注释、`docs/archive/m7-phases.md`/`AGENT_ONBOARDING.md`/`SKILL.md`）。
另：`runs/` 与 `runtime/` 语义重叠（都是运行时状态的家）——handshake 进 `.wao/runtime/` 会把
daemon 进程状态与它驱动的 transcript 分裂两处。

**性质**：设计取舍点，需 owner 拍板。**dogfood 数据支持改**（D-F4 是真实 friction），但**有语义冲突
需权衡**（与 runs/ 重叠 + 状态分裂）。owner 选择"先 dogfood 再定"——本文即该 dogfood 输入。

## 总结：daemon 当前状态评估

P3-T1 的"机械 smoke"通过（daemon 进程本身正确：start/ping/list/stop/幂等/无孤儿/心跳/resume-scan 单测绿），
但 **agent 视角的端到端可用性有真实缺口**：D-F1（无派发入口）使 daemon 当前**实际无法用于真实编排**。
D-F2/D-F3 是 D-F1 的连带——因为没派发入口，agent 只能混用 P2，暴露了两套路径隔离的割裂与竞态。

**优先级建议**：D-F1（补 `daemon run` CLI bridge）是 unlock daemon 实际价值的关键，应优先。
D-F2/D-F3 在 D-F1 之后才有意义（有了统一派发入口，才能定 daemon vs background 的关系）。
D-F4（handshake 位置）是独立的设计取舍，待 owner 拍板。
