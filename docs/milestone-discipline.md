# Milestone 工作纪律

> 状态：✅ 强制执行。
> 每个 milestone 必须按此纪律执行，不允许跳过 gate 或遗留技术债。

## 1. Task 拆分要求

每个 milestone 在动工前必须拆成独立 task。每个 task 必须有：

- **task ID 和标题**（如 M0-1: transcript.js 扩展）
- **输入**：依赖哪些前置 task 或文件
- **输出**：产出哪些文件、改动哪些函数
- **验收 checklist**：可逐条勾选的检查项（不是"做好了"，是"验证了什么"）
- **验收 gate**：明确判定 task 完成的硬条件（通常是测试通过）

## 2. 验收 gate 的形式

gate 必须是**可执行验证**，不能是主观判断：

- ✅ 好："`node --test test/transcript.test.js` 全绿，且含 seq 单调递增的断言"
- ❌ 坏："transcript 扩展完成"

gate 类型按 task 性质选：
- 代码 task：测试通过 + lint/类型检查（若有）
- 文档 task：内容覆盖关键点（checklist 式）
- 重构 task：行为不变证明（旧测试全绿）+ 新能力证明（新测试）

## 3. 技术债审计（每个 milestone 收尾必做）

milestone 完成后，必须审计以下技术债类别。**发现的技术债要么当场修，要么记入 backlog 并标明不修的理由和触发条件。**

> **全局登记表**：所有技术债的单一权威清单是 [`docs/tech-debt.md`](./tech-debt.md)。
> 各 `docs/archive/mX-audit.md` 只记本里程碑的**动态**（新登记 / 偿还）+ 指向 tech-debt.md；
> tech-debt.md 负责全局汇总（编号、状态、触发条件）。收尾时必须同步更新两处，
> 确保任何文档引用 TD-XX 都能在 tech-debt.md 查到对应条目。

| 类别 | 检查内容 |
|------|---------|
| **代码异味** | 动态 import 本可静态、重复代码、死代码、注释掉的代码 |
| **接口契约** | 函数签名与 spec 不一致、可选参数未文档化、错误处理不一致 |
| **测试覆盖** | 边界条件未测、错误路径未测、幂等性未测、并发未测 |
| **向后兼容** | 旧格式/旧路径是否被新代码正确处理（本 milestone 的行为变更是否破坏历史 run） |
| **依赖方向** | 上层是否泄漏到下层、模块边界是否被违反 |
| **未完成项** | plan 里列了但实际没做的、临时 hack 留了 TODO 的 |

## 4. 完成定义（milestone 级）

milestone 标记 ✅ 前必须满足：
1. 所有 task 的验收 gate 全绿
2. 技术债审计完成（已修或已登记）
3. `npm test` 全绿
4. **涉及外部系统交互的 milestone，必须跑 `npm run smoke`（真实 CLI），不能只靠 mock 报绿**
5. 更新 `docs/roadmap.md` 进度表，附测试数

## 5. 不留技术债的原则

- 发现即修，不推到下个 milestone（除非修复成本 > 当前 milestone 价值，且已登记）
- 每个临时桥接代码必须标注"何时拆除"（如 M0 的 waitForCompletion 桥接标注 M1 拆除）
- 不允许"先跑起来再说"的未测代码合入

## 6. 实战经验（M0–M2 沉淀）

以下经验由真实踩坑验证，后续 milestone 必须遵守：

### 6.1 mock 证明"逻辑对"，真实 smoke 证明"系统能跑"

- M2 的 TD-17（codex.cmd spawn EINVAL）和 TD-18（opencode 流式 parts 竞态）都是 mock 永远抓不到的。
- mock 用 `process.execPath`（真 exe），mock 消息一次性完整返回——永远不会碰到 .cmd 包装器或流式追加。
- **规则：涉及外部系统（CLI 进程、HTTP serve、文件系统）的 milestone，收尾必跑 `npm run smoke`。**

### 6.2 红绿测试纪律

- 先写测试（红）→ 确认失败原因正确（是"模块不存在"不是"别的错"）→ 再实现（绿）。
- M2 parser 层 4 个 sub-task 全程红绿，零返工。
- **规则：新模块必须红绿。重构（改现有代码）可用"旧测试全绿 + 新测试补充"替代。**

### 6.3 技术债审计要逐文件，不只全局 grep

- M0 的 TD-1 和 M1 的 TD-8 是同一个"动态 import"模式的两处。全局 grep 只找到第一处，逐文件审查才找到第二处。
- **规则：审计时打开每个改动过的文件通读，不靠关键词搜索偷懒。**

### 6.4 "禁做"边界和"必做"清单同等重要

- M2 plan 明确"不做证据链事件（留 M6）""不做 message 去重（留 M6）"——这些禁做项防止了范围蔓延。
- **规则：每个 sub-task 必须写"禁做"清单，和"必做"清单成对出现。**

### 6.5 主动审计，不等用户要求

- M0 审计是用户要求后才做的（回溯），抓出 3 个真实 bug。
- M1/M2 审计在收尾时主动执行，抓出 TD-11（作用域 bug）。
- **规则：milestone 收尾时主动走审计流程，不等用户要求。**

### 6.6 修一处必须验证所有同类路径（跨完成模式/跨 provider）

- 2026-06-17 事故：修了 first-stable 的 text 完成判据，没同步到 snapshot-stable（GLM 伪完成）；
  修了 snapshot-stable 的 session-endpoint metrics，没同步到 first-stable（metrics 偏小）。
  两次都是"局部修复"，被独立 reliability 测试（codex）打脸。
- **规则：涉及完成判定 / provider / metrics 的修改，必须问"同类路径（另一个 completionMode、其它 provider）有没有同样问题"，
  全部验证才算完成。npm test 全绿 ≠ 实测可用。**

### 6.7 reliability 套件：完成判定/provider 路径修改的硬门槛

- `npm test`（mock）只验证逻辑对；`npm run reliability`（真实 provider）验证"系统能跑 + 输出对 + 真完成"，并输出 runtime+model certification。
- reliability 读取 registry 的 `certification.matrix`（缺省回退 legacy 矩阵），用 sentinel 方法（读文件再答，防背诵/防伪完成）+ 可配置 drills 认证 runtime/model；`--profile strict` 额外确保 command/file scorecard drill，避免只凭 sentinel 把 worker 误标为 strict-dispatch capable。
- **规则：任何修改 completion 判定 / metrics 提取 / provider 错误处理 / silentTimeout 的 PR，
  收尾必须跑 `npm run reliability`（三 provider 全绿），不能只靠 npm test 报绿就声称完成。**
- reliability 消耗真实 token，不进 CI；定位是"大改后/发布前必跑"，和 smoke 同级但更深。
- **单 worker 重认证不覆盖全量**：`npm run reliability -- --agent X` 跑完会增量合并——读磁盘旧 summary 的 cases，本次结果覆盖同 caseId（重认证刷新），未重跑的 worker 保留。可安全单跑修复一个 worker 而不丢失其他 worker 的认证结果。
- 单 worker 默认超时 300000ms（`--wait-timeout` 可覆盖）；strict profile 含 scorecard+isolation+workflow 多 drill，120s 在重 worker 上易卡边界。全量批跑时每个 worker 独立计超时（非全量总时长）。
