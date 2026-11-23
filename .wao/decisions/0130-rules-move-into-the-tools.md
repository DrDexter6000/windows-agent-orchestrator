# 0130 规矩下沉——让工具记住 Lead 现在要背的几条规矩

- 日期：2026-11-23
- 状态：accepted
- 来源：2026-11-22 Lead 体验回顾与三席头脑风暴（kimi、fable、astra）`consult_20261122213714170p5n8mk`：Lead 记忆里约 20 条派发、会审、验证的操作规矩，每条都是踩过一次的坑，只存在某个 Lead 的私有记忆里，换宿主、换 Lead 就丢；结论是"规矩下沉"——能变成默认值的变默认值，必填参数在 schema 里标必填，拒绝文案带改法。Owner 同日同意执行。第 135 批交付。
- 关系：多数规矩已由工具兜住，本批做剩余四件；照决定 0125/0129 的做法执行（新决定 + 0021 追加记录 + 字节天花板按实测重冻且只降不升 + SKILL 与手册同批改好 + 不留旧说法过渡桩）。

## 决定

1. **`run_continue` 的 `delivery` 可省，省略时继承父运行已生效的交付合同。** 子运行使用父运行已生效的整份合同（allowedPaths、verificationCommands、verificationSetupCommands、verificationTimeoutMs、verificationUnavailableReason）——只从父运行转录 `run.started` 里已落盘的合同事实取，不从别处推断；父运行若是续修，取它自己 `run.started` 里那份（就是它自己启动时生效的合同）。这不扩大范围：继承的是 Lead 先前已批准的范围。第 11b 步的累计范围核照旧在生效合同上执行；继承来的合同若仍覆盖不了，照旧拒于 `continuation_scope_incomplete`。Lead 显式给了 `delivery` 时行为完全不变（包括漏路径时拒绝并列出未覆盖路径）。继承的事实告知走受理回执 `nextStep` 的半句固定文案（不新增 wire 字段）。
2. **八个写类 MCP 工具的 `expectedWorkspaceRoot` 在 schema 里标必填。** `run_dispatch`、`run_continue`、`run_correct`、`run_stop`、`run_collect`、`run_delivery_decide`、`run_delivery_reverify`、`run_delivery_repackage` 的处理器本就必传；schema 标必填后模型看 schema 即知，缺参在 wire 校验即被拒，不再"被拒一次才知道"。`run_dispatch` 与 `run_dispatch_contract_check` 共享输入 schema——从共享基础对象派生 run_dispatch 的严格版（只把这一个字段改成必填），不复制整份；contract_check 可用缺省绑定，保持 optional。`run_consult` 的读取/分页模式可用缺省绑定，保持 optional；其余只读工具不动。处理器里原有的缺参固定文案拒绝保留（schema 校验在前，处理器兜底不删）。
3. **`delivery.mode` 可省，缺省 `git_commit_v1`。** 它是唯一的交付模式（`src/delivery.js` 校验处不变）；省略按 `git_commit_v1`，显式给了别的值照旧拒绝（文案保留，说明唯一合法值）。dispatch、continue、repackage 凡接受 delivery 对象的入口一致处理（DELIVERY_INPUT 同一份 schema）；CLI `--delivery-spec-file` 同样可省 `mode`。
4. **worker 留下的暂存改动不再让打包失败。** 打包前只重置索引到基线（`git reset -q`，混合模式，不动工作树文件），以工作树内容为准继续打包；重置掉的暂存路径清单（有界、仓库相对，截断如实标注）作为 DeliveryRef 的 `stagedResetPaths` 随 `run.delivery_created` 落转录。打包本就以工作树内容为准、只提交 allowedPaths 内的改动，重置索引不改变交付内容。重置本身失败（含重置后缓存 diff 仍非空）照旧按 `pre_staged_changes` 失败（fail-closed）——该码因此保留在闭集内（仍可产生 + 历史转录读取兼容），`run_delivery_repackage` 对它的 `worktree_unusable` 映射不变。
   - 威胁模型：这道门防的是"打包提交了与工作树不一致的内容"，不防 worker 有意构造。必改口径：只有"重置后交付内容与工作树不一致"或"工作树文件被改动/丢失"才算必改。已实测定格的内容丢失面：暂存内容与工作树不一致 → 交付工作树版本（staged-only 字节不进提交）；暂存的新文件仍在工作树 → 重置后按未跟踪文件检出并交付；**暂存后从工作树删掉的文件（staged-only blob）随索引条目一起消失、不进交付**——按工作树权威口径这是"工作树里没有的内容"，不算内容丢失，测试定格（2A-16d）；工作树文件字节全程不被重置触碰（2A-16/16f 实测）。

## 不采纳

- **给了 `allowedPaths` 也自动并入继承路径**：M12-22 的"Lead 明确批准范围"原则——显式合同漏路径时必须拒绝并列出未覆盖路径，不能静默并入；继承可省的只是"Lead 抄父运行合同"这道誊写工序，不是范围批准本身。
- **给继承加新的拒因码**：继承合同复验失败与显式合同非法是同一类（child delivery contract failed prepareDeliveryRequest），复用闭集既有成员 `invalid_delivery`；父缺 delivery 上下文复用既有 `no_delivery`。闭集不扩员。
- **`run_dispatch` 的 schema 直接改成必填**：它与 `run_dispatch_contract_check` 共享输入对象，后者现在自己消费该字段且可用缺省绑定——从基础对象派生严格版，不复制整份。
- **把 `expectedWorkspaceRoot` 从描述里整句删除**：schema 标必填只表达"必传"，不表达"传什么"（absolute Git worktree top-level）；描述里保留归属语义句，只删与 schema 重复的 requiredness 措辞。
- **为重置事实新增转录事件类型**：DeliveryRef 本就随 `run.delivery_created` 全量落转录——加字段即加事实，不加事件、不动冻结的事件登记表。

## 影响

- 续修调用不再需要 Lead 把父运行合同抄一遍；漏抄导致的 `continuation_scope_incomplete` 首拒（及其重试）从常态路径上消失。
- 八个写类工具缺 `expectedWorkspaceRoot` 的调用被宿主 wire 校验拒绝（SDK InvalidParams 点名参数）；原固定文案（缺参零副作用）保留为兜底，wire 上不再可达。
- 交付 spec 与 delivery 块省 `mode` 即按 `git_commit_v1`；写错值照旧拒绝。
- worker 暂存改动不再让整轮交付失败；每次发生重置，转录里有一条有界的路径清单事实可查。
- MCP 工具面字节天花板三条按实测重冻（76543→76532、10402→10231、20870→20859；均只降不升），DESC_STRIPPED_CONTRACT_SHA 如实翻新。


## 修订条（2026-11-23，第 135 批续修；两席会审 kimi、sol 均 FIX_FIRST，Lead 裁定）

会审实测复现出五处实现偏差，按裁定修正；上文机制描述以本条为准：

1. **先证明、后重置**：先证工作树身份/分支/基线（各类身份拒绝都让索引保持原样），再显式重置到已证明的基线（按路径重置到 canonicalBase，不移动分支）。
2. **被忽略的暂存新增 fail-closed**：重置前发现"暂存为新增、在工作树里、且会被忽略"的路径（`git mv`/`add -f` 形态），按 `pre_staged_changes` 拒绝并点名路径，不动索引（不加交付被忽略文件的新机制）。
3. **清点与真实索引无关**：列改动的读取（含重打包候选清点）改在持有 base 树的临时索引上跑（本工作树 git 目录内、用完即删），与重置后同口径；`git rm --cached` 不再误报越界。
4. **重置事实随失败落转录**：重置后打包失败时，事实随 DeliveryError 带出、写进 `run.delivery_failed`。
5. **继承合同按子运行启动同款规则校验**（非 persisted），持久化 mode 须逐字 `git_commit_v1`；commands 与 unavailableReason 同存、字符串 setup 等"补值或丢字段"一律 `invalid_delivery`，MCP 回执对该拒绝带固定 guidance（显式传 delivery 可覆盖）；`delivery.mode` 仅 undefined 取默认，`null` 照旧 `invalid_mode`。

**威胁模型补充（已知局限）**：重置不改变交付内容，事实只作审计。崩溃窗口（提交已生成、`run.delivery_created` 落盘前）里事实可能随恢复路径丢失；证明后分支被外部移动时，拒绝前索引已重置；重打包拒绝审计事件保持既有固定形状。
