# 12 — P0 真任务 dogfood（M7 起步）friction 清单

> 类别：**过程（Process Log）**，时间冻结快照。记录 M7-P0（用 WAO 编排自己补 handoff.js 测试）
> 的真实执行 friction，喂给后续 phase 优先级。不复制架构/状态机（见 02-architecture.md）。

## 任务

P0（`docs/archive/m7-phases.md`）：用 WAO 编排自己——researcher 读 `src/workflow/handoff.js` 产 brief →
coder_hq 在隔离 worktree 写 `test/workflow/handoff.test.js` → 验收。目标：真实交付物 +
真实 friction 清单。**非 sentinel，真实复杂任务**。

## 结果

- ✅ 交付：`test/workflow/handoff.test.js`（+11 测试，覆盖 3 函数的正常路径/抛错/边界），
  填补 handoff.js 此前仅间接覆盖的真实缺口。合并主工作区 440 全绿（commit 15049d9）。
- ✅ 全链 worktree 隔离生效：两个 worker 各自隔离 worktree，主工作区无污染，用完即清。
- ✅ scorecard 门生效（coder_hq 带 requireFiles+requireEvidence，门通过）。
- ✅ 无残余进程。
- 成本：researcher $0.20 + coder_hq $0.46 = ~$0.66。

## 真实 friction 清单（喂给 m7-phases）

### P0-F1：链式隔离任务每个 run 各一个 worktree，不共享（实证决策 0010 的"人肉消息总线"）

**现象**：researcher 跑在 worktree A，coder_hq 跑在 worktree B（各自隔离）。coder 拿不到
researcher 在 A 里的产出，我作为 lead **手动把 brief 的要点抄进 coder 的 prompt**——决策 0010
抽象指出的"人肉 relay"，P0 实证。

**根因**：`--isolate` 给每个 run 独立 worktree，但**没有"同一任务共享一个 worktree"或"upstream
产出自动注入下游 prompt"的机制**。run 的输出也没把 worktree 路径放显眼处（我在 worktree list
里翻才找到）。

**对 phase 的启示**：
- 直接验证 **P4（LLM 编排器）** 的"引擎注入 ctx.upstream.X.text"是高优先——它正是解这个。
- worktree 路径应在 run 输出/header 显眼处（决策 0010 融合项 #2 的子项）。
- 短期可考虑"任务级 worktree"（一个任务一个 worktree，多 worker 共享）作为隔离粒度。

### P0-F2：coder 的产出在隔离 worktree，合回主工作区要手工 cp

**现象**：coder_hq 在 worktree B 写了测试文件，但它在 B 里，不在主工作区。我 **手工 `cp`
到主工作区**才让它成为真实交付。

**根因**：隔离是对的（防污染），但**没有"验收通过后自动合并/提供合并指引"的机制**。
worktree remove 是清理，但合产出现在是 lead 手工活。

**对 phase 的启示**：验收门通过后，应有一个"交付物从 worktree 提取/合并"的标准动作
（P4 融合项，或一个 `worktree deliver <runId>` 命令）。

### P0-F3：`node --test test/`（裸目录）行为不稳，要 `npm test`

**现象**：我在 worktree 里跑 `node --test test/` 得到 "tests 1 / fail 1"（误报），
改 `npm test`（`node --test` 无参）才正确出 440 全绿。

**根因**：Node 的 `--test` 对裸目录的 glob 行为依赖版本/平台，`npm test`（package.json 的
`node --test`）才稳定。这是 Node 工具链细节，非 WAO bug，但 tester worker 若直接跑
`node --test <dir>` 会踩。

**对 phase 的启示**：tester 角色的 prompt 应明确"用 `npm test` 而非 `node --test test/`"，
或 WAO 给 tester 一个稳定的测试运行封装。

### P0-F4：scorecard 在隔离 worktree 里的 requireFiles 路径是 worktree 相对路径

**现象**：coder_hq 的 scorecard `requireFiles:["test/workflow/handoff.test.js"]` 验证的是
worktree B 内的路径——门通过，但**门不知道这文件在主工作区还不存在**。验收门通过 ≠ 交付到主工作区。

**根因**：scorecard 验证的是 worker 的 cwd（worktree）下的文件，与最终交付的合并状态是两回事。
隔离正确，但"门通过"和"交付完成"之间有 gap（同 P0-F2）。

**对 phase 的启示**：验收语义要区分"worker 产出（在 worktree）"与"交付落地（合并后）"。

## 走得顺的（不需改）

- registry list（N1）一眼出 cert 状态，选 coder_hq 无犹豫。
- `run --isolate` 真隔离、worktree list/remove 真管理（标准动作成立）。
- scorecard 门对 worker 内产出有效（hasEvidence/filesExist）。
- transcript 完整（N4），collect 可用（N4b）。
- researcher/coder_hq 产出质量高（brief 精确、测试真测行为非空壳）——认证过的 worker 干真活靠谱。

## 对 m7-phases 优先级的启示（更新建议）

P0 实证了**决策 0010 的"操作员→声明者"不是抽象愿景，是真实每天踩的 friction**：
- P0-F1（人肉 relay）→ P4 的 upstream.text 注入是高优先，不只是"nice to have"。
- P0-F2/F4（worktree 产出到交付的 gap）→ 是隔离模型的真实缺口，P3/P4 要处理。

**但 P2（watchdog）的优先级未被动摇**——P0 是人在环里跑（--wait），没触发无人值守的安全洞；
06-18 架构洞仍是最该先补的安全项。**维持建议起步顺序 P0→P1→P2**，P0 已完成。
