# 0096 验证者已不在时等待器如实退出；consult 回执与 CLI 给出下一步

- 日期：2026-10-30
- 状态：accepted
- 来源：Owner 2026-10-30 批准第 51 批（"我认为可按上述计划继续推进了"）：补上决定 0095 的已知边界（终态等验证时等待器可能一直挂着），并给 `run_consult` 补 `nextStep`，含本批 MCP 工具面重冻（决定 0078）。
- 关系：补决定 0095 的已知边界与 `nextStep` 出现面。TD-179 仍开放（见"已知边界"）。不改决定 0030、0067–0069（只告知，去留由 Lead 定），不改有界 pending 拒绝（`docs/02-architecture.md` §4.9）。
- 方案会审：kimi 与 deepseek-flash（consult_20261030064227590ho6meu）。两席都指出原方案的证明有漏洞（租约写失败、前台续跑、活 daemon），并建议拆小；本决定据此改为只读的精简版。
- 合入授权：Owner 2026-10-12——"只要是你联合会审过的，我都许可 commit & push"。

## 背景

- 交付验证在驱动运行的进程里跑：先原子写 `delivery_created`（验证 pending）与 `completed`，再跑验证、追加结果。后台 runner 每 2 秒覆写 `runs/.owner-<runId>`，结果落盘、驱动返回之后才删除。`resume` 与 daemon 都跳过终态运行。
- 这个进程在验证期间死掉，转录就停在 completed + pending，`runs wait --until-settled` 会一直等。
- 频率（2026-09-01 至 10-30 的转录）：387 个交付运行里 366 个后台、21 个前台；验证停在 pending 的只有 1 个，是 09-21 的前台运行（宿主关闭）。后台形态没有出现过。
- 原方案（settle 记一条 `verification_interrupted` 失败结果，再走 reverify）要动交付事实的写面、reverify 资格、MCP 失败码枚举，还要把 runner 自己的结果追加改成 CAS，才能避免两条结果造成永久的 malformed。为一个尚未出现过的后台形态，代价过大。

## 决定

1. **只读证明 `proveVerifierGone`**（与 `runs settle` 的门共用读器与判定）。全部满足才判"验证者已不在"：
   - 终态 `completed`，交付已创建且显式 pending，无结果，无 reverify 事实；
   - 恰好一条绑定的 `run.background_submitted`。前台运行拒：验证在 Lead 自己的 `wao run` 进程里跑，转录不记它的 pid，无从证明；
   - 没有绑定的 `run.rerun`：驱动进程换过，租约的主人不一定是验证者；
   - owner 租约缺失，或过期且 owner pid 判已不在；损坏、新鲜、身份判不了都拒；
   - 最后一条绑定事件至少 15 分钟前；
   - 没有可能在驱动它的活 daemon：握手新鲜，或过期但 pid 未证明已不在，并且 daemon 在运行到达 completed 之前就已启动，才算有。daemon 跳过终态运行，晚于 completed 启动的 daemon 不可能是验证者；
   - 进程扫描找不到命令行带 `--run-id <runId>`、`--resume-run-id <runId>` 或 `resume <runId>` 的进程；扫描失败即拒。扫描的这条匹配同样用于 `runs settle` 的门 3：前台 `wao resume <runId>` 续跑的运行，原先会被误判为没有 runner。
2. **等待器**：终态等验证的轮调用这项证明，同一等待器每 5 分钟至多一次。证明成立后重新解析、重读转录、再判一次收口：已收口就照常退出 0；仍在等验证就退出 3（`verifier_gone`），给出依据与下一步。runner 先写结果、后删租约，所以"先证明、后重读"不会把一个刚写完结果正在退出的 runner 判成死。
3. **出口沿用现有的，不新增写面**：还没有决定时，验证 pending 的交付可以有界拒收；要用其内容，按采纳协议手工采纳（`docs/usage/delivery.md`）。已经拒收的，说明没有可等的了。
4. **consult 的 `nextStep`**：有已派发、还没到终态、转录读得到的席位时，MCP `run_consult` 回执（创建与读取两条路径）带 `nextStep`：对这些席位反复 `run_wait`，再按 consultId 重读。CLI `consult run` / `wait` / `show` 带 CLI 面文本：对每个席位 `runs wait <runId> --until-settled`，宿主能后台就放后台，否则在前台逐个等。CLI 列出 runId；超过 480 字符时改用不列 runId 的版本。

## 否决的备选

- **settle 记一条 `verification_interrupted` 失败结果，再走 reverify**（原方案）：能给出正式结论，但写面、资格集、MCP 枚举都要改；runner 的迟到结果会造成两条结果，要么接受永久 malformed，要么改 runner 的追加路径。等后台形态真的出现再做（TD-179）。
- **前台运行由 Lead 断言验证者已死**（`--assume-verifier-gone`）：没有证据可核，只换来一个 WAO 无法证伪的写入。
- **新的结果事件类型**、**settle 替死去的 runner 跑完验证**、**等待器或 daemon 自动写事实**：同 TD-179 的取舍，或违反"WAO 只告知，出口由 Lead 决定"。
- **`consult wait --until-settled`**：现有的逐席 `runs wait --until-settled` 已能等到终态，不再加一个命令。

## 已知边界

- 前台运行、续跑过的运行（`run.rerun`）、证明不成立（租约损坏、身份判不了、活 daemon、扫描失败）时，等待器照旧等待。
- 续跑走 attach 分支（HTTP 类 backend）时不写 `run.rerun`。这时只靠进程扫描排除前台 `wao resume`。
- reverify 请求之后进程死了（reverify pending）仍会让等待器挂着；再调一次 reverify 会接着跑（既有的崩溃恢复）。
- 只有 CLI 等待器做这项证明（它要起进程扫描）；只用 MCP 的 Lead 看不到 `verifier_gone`。
- 交付内容完好的中断形态仍没有正式的验收出口：只能拒收后手工采纳（TD-179）。
- 进程扫描读不到命令行的 node 进程（如会话 0 里的计划任务进程）时，只有早于本运行提交的才不算；读不到创建时间的仍按扫描失败处理。时钟被大幅回拨可能让这条与 daemon 的先后比较判错。
- 只看当前这一份 daemon 握手：一个在本运行到达 completed 之前启动、仍活着的 daemon，如果它的握手被一个之后启动又失败的 daemon 覆盖，会被放行。
- 扫描是子串匹配：runId 带引号的 `resume "<id>"` 会漏中，相似串会误中（误中只会多等）。
- CLI 的 `nextStep`（这里与 consult 的）不带 `--cwd` / `--run-dir`；在非默认目录下运行的 Lead 照抄时要自己补上。
