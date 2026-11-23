# 0129 MCP 工具面 20 → 17：三个只读工具的能力并进幸存者后删除；`run_dispatch_contract_check` 保留

- 日期：2026-11-23
- 状态：accepted
- 来源：2026-11-22 Lead 体验回顾与三席头脑风暴（kimi、fable、astra）`consult_20261122213714170p5n8mk`；Owner 同日："4 个只读 MCP 工具有等价物，可以下沉——能力不丢的前提条件下，同意删"。第 134 批交付会审（sol）核出能力丢失与缺陷，Lead 2026-11-23 裁定 `run_dispatch_contract_check` 保留、其余按会审意见修正（本决定已按裁定改写）。
- 关系：照决定 0125 的做法执行（新决定 + 0021 追加记录 + 字节天花板按实测下调重冻 + SKILL 与手册同批改好 + 不留旧名过渡桩）；红线（不做通用 meta-tool、不做动态隐藏工具，决定 0078）不变。

## 背景

用量（11-14 至 11-22 本机 Lead 会话）：`registry_list` 3 次、`runs_list` 1 次、`run_dispatch_contract_check` 3 次、`run_delivery_review_bundle` 0 次。四者都是只读。前提条件是**能力不丢**：只有 MCP、没有命令行的宿主（决定 0127 明文照顾的那类）删前能做到的，删后仍要能做到。

`registry_list`/`runs_list` 可完整并入 `lead_preflight`（同一 `AGENT_ENTRY`、同一 `listRuns` 服务），`run_delivery_review_bundle` 是纯组合。但 `run_dispatch_contract_check` 的"**只预检不派发**"（worker 启动前看 `contractValid`/`issueCodes`/节状态/路径提醒并据此改请求）与"省略 `executionProfileId` 时列出 `availableProfiles`"在 MCP 面没有等价物——删了就是真实能力丢失，会审据此否决。

## 决定

1. **`run_dispatch_contract_check` 保留，不删。** 与 `run_dispatch` 继续共享输入 schema 与同一 application 预检服务；能力、输出边界、`workspaceScope`、零副作用语义不变。CLI 无对应预检入口，本批不新增。
2. **`run_dispatch` 派发时自动预检，规矩下沉（与独立预检并存）。** 派发前就地跑同一份预检。合同级问题照旧在任何副作用之前拒绝（权威仍是 `run_dispatch` 的既有固定文案与拒绝语义，dispatcher 计数为 0）；advisory 码（`CONTRACT_CHECK_ADVISORY_CODES` 闭集：`workspace_unbound`、`registry_unreadable`、`agent_not_found`、`referenced_path_probe_miss`、`verification_dir_test_form`、`verification_bare_node`）写进受理回执可选数组 `contractAdvisories`（闭集码 + 固定说明；零提醒不带该键），`nextStep` 有提醒时加半句"先看它，需要就停掉重派"。
3. **预检绝不误拦。** 预检自身的意外异常（非 typed `DeliveryError`）一律按"提醒缺席"处理：`contract` 节记 `unknown`、不产出该节的合同级码；`contractValid:false` 只表示**预检本身没完成，不是合同错**。与该异常无关的 advisory（workspace/registry/lint/路径探针）照旧给出并随回执携带——不因一处异常丢掉其它真实提醒；派发照旧走 `run_dispatch` 的权威结构校验，只有原本就会拒的合同缺陷才提前拒。`contractAdvisories` 在派发**之前**用 wire schema 严格预校验，畸形/超限整组丢弃（回执不带该键）。`observations` 在服务层按每节一条有界合成（四类问题叠加也不超 schema 上限，绝不折成整次失败）。
4. **`registry_list` → `lead_preflight.workers`。** `workers[]` 条目改用与原 `AGENT_ENTRY` 同一个 schema 对象（同一份定义）：preflight 因此补上 `cwd`、`sessionReuse`、`missingCredentialEnvNames`、`dispatchHold`。**workers 不设比原工具更紧的上限**：原 `registry_list` 返回全部有效席位，registry 本身也没有条目数上限（`readRegistry` 逐条读 `agents`），preflight 用同一边界、schema 不设 `max`（会审修正：删掉原 `WORKERS_CAP=64`）。可选 `detail:"certificationEvidence"` 搬到 `lead_preflight`（同一闭集；输出同名可选键，服务失败整次 fail-closed）。CLI `wao registry list` 不动。
5. **`runs_list` → `lead_preflight` 可选近期运行（两种查询都补齐）。** 输入 `recentRuns: {limit?: 1..100, activeOnly?: boolean}`（limit 缺省 50；activeOnly 先筛经证明活动的运行、再截断，同一 `listRuns` 语义）；输出可选键同原 `runs_list.runs[]`（含 `activityStatus`/`activityBasis` 与 `unresolvedCount`、`returnedCount`/`truncated`）。不请求 = 键缺席、不扫描；请求了但读不出/未绑定 = `null`（绝不伪造空清单，Lead 能区分"没请求"与"读不出"）。范围同原工具（`expectedWorkspaceRoot` 当场证明）；复用同一服务。该节不进 `checkStatus`/`complete`。CLI 不动。
6. **`run_delivery_review_bundle` → 删除。** 由 `run_delivery`（带 `waitMs` 的一次等待）+ `run_delivery_review`（一页审查）两次调用替代；**两次调用没有组合工具的跨结果保证**，Lead 要对照 `run_delivery_review` 回执里的 `deliveryCommit` 与 `changedFileCount` 和 `run_delivery` 结果是否一致。指向它的地方改指这两个原子工具。
7. 破坏性变更，下次发版升 MINOR（决定 0109）。三条字节天花板按实测下调重冻，且均低于 2a1875ac 的冻结值（只降不升；见 0021 追加记录）；宿主重启 MCP 服务后生效。

## 不采纳

- **删除 `run_dispatch_contract_check`（首轮交付的做法）**：会审否决——"有等价物"对它不成立。就地预检只在派发后给提醒，不能"在 worker 启动前只检查并据此改请求"；`availableProfiles` 是挑选 profile 的输入，派发后才看到就晚了。首轮 20 → 16，本轮修正为 20 → 17。
- **给 `run_dispatch` 加 `checkOnly` 替代独立预检**：会让破坏性工具承担只读调用，回执形状变两种，且"预检"与"派发"共用入口会把语义绑死。
- **workers 沿用 `WORKERS_CAP=64`**：比原 `registry_list` 更紧，会静默丢掉第 65 个及以后的席位——违反"能力不丢"前提。
- **`recentRuns` 只保留条数、不补 `activeOnly`**：原工具的两种查询只承接一半；截断发生在筛选之前会让结果失真。
- **给 `registry_list`/`runs_list` 留薄壳**：留桩只会让两套说法并存更久（同 0125 的过渡桩裁定）。
- **把 `unresolvedCount` 等运行事实复制进默认 preflight 输出**：recentRuns 保持按需——不请求零额外扫描，默认载荷不膨胀。

## 影响

- 调用已删的三个工具（`registry_list` / `runs_list` / `run_delivery_review_bundle`），宿主报未知工具；`run_dispatch_contract_check` 照旧可调用。SKILL 与手册已同批改好。
- `lead_preflight` 的 workers 条目形状变宽（additive 字段）、不再截断；输入多两个可选成员（additive）；`recentRuns` 新增 `activeOnly` 查询语义。
- 每个 `run_dispatch` 调用多一次只读预检查（读注册表 + 按调用目标 stat 探针；无副作用）。预检自身意外失败按提醒缺席处理，不拦派发。
- 原 `runs_list` 的"未绑定固定错误"语义随工具消亡：preflight 对未绑定如实报 `workspace.bound:false` + `recentRuns:null`（不跨项目、不伪造空清单）。原 `registry_list` 的"整源不可读整次 isError"改为 `workers:null` + `checkStatus.workers:"unknown"`。
- CLI 面零改动（`registry list` / `runs list` / 无预检入口照旧）。
- 派发对"缺验证且 allowedPaths 含 `..`"的请求现在先命中更具体的 `invalid_allowed_paths` 专属文案（基线是通用 `run_dispatch failed`）；两版都零派发，更具体的拒绝文案是改进。
