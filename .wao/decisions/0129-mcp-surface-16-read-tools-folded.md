# 0129 MCP 工具面 20 → 16：四个只读工具的能力并进留下的工具后删除

- 日期：2026-11-23
- 状态：accepted
- 来源：
  - 2026-11-22 Lead 体验回顾与三席头脑风暴（kimi、fable、astra）`consult_20261122213714170p5n8mk` 认定四个只读工具有等价物、可以下沉。
  - Owner 2026-11-22："4 个只读 MCP 工具有等价物，可以下沉——能力不丢的前提条件下，同意删"。
  - 第 134 批。
- 关系：照决定 0125 的做法执行（新决定 + 0021 追加记录 + 字节天花板按实测下调重冻 + SKILL 与手册同批改好 + 不留旧名过渡桩）；红线（不做通用 meta-tool、不做动态隐藏工具，决定 0078）不变。

## 背景

用量（11-14 至 11-22 本机 Lead 会话）：`registry_list` 3 次、`runs_list` 1 次、`run_dispatch_contract_check` 3 次、`run_delivery_review_bundle` 0 次。四者都是只读；其中三个的能力已被 `lead_preflight` / `run_dispatch` 覆盖大半，bundle 是两个原子工具的纯组合。前提条件是**能力不丢**：只有 MCP、没有命令行的宿主（决定 0127 明文照顾的那类）删前能做到的，删后仍要能做到。

## 决定

1. **`registry_list` → `lead_preflight`**。`lead_preflight.workers[]` 条目改用与原 `AGENT_ENTRY` 同一个 schema 对象（同一份定义，不再各写一份）——preflight 补上 `cwd`、`sessionReuse`、`missingCredentialEnvNames`、`dispatchHold`；workers 上限（`WORKERS_CAP=64`）与截断语义照旧。原可选 `detail:"certificationEvidence"` 搬到 `lead_preflight` 的可选输入（同一闭集），输出同名可选键 `certificationEvidence`（同一 `CERT_EVIDENCE_ROW`；没请求就没有这个键；请求了服务失败就整次 fail-closed，照原规矩）。指向它的报错与说明文字改指 preflight 的 workers。CLI `wao registry list`（含 `--cert-evidence`）不动。
2. **`run_dispatch_contract_check` → `run_dispatch` 自动预检**。`run_dispatch` 在派发前就地跑同一份合同解析与观察（`runDispatchContractCheck` 同一函数，不复制）。会让派发被拒的问题照旧在任何副作用之前拒绝（权威仍是 run_dispatch，既有固定文案与拒绝语义不变，dispatcher 调用计数为 0）；只是提醒、不拦截的 advisory 码（`CONTRACT_CHECK_ADVISORY_CODES` 闭集：`workspace_unbound`、`registry_unreadable`、`agent_not_found`、`referenced_path_probe_miss`、`verification_dir_test_form`、`verification_bare_node`）写进受理回执的可选数组 `contractAdvisories`（闭集码 + 服务侧同一句固定说明；零提醒不带该键）。回执 `nextStep` 在有提醒时加半句：先看 `contractAdvisories`，需要就停掉重派。"派发前先预检"的知识不再靠 Lead 记得去调另一个工具。CLI 无对应预检入口，不新增（本批只动 MCP 面）。
3. **`runs_list` → `lead_preflight` 可选近期运行**。`lead_preflight` 加可选输入 `recentRuns`（整数 1..50），输出可选键 `recentRuns` 返回与原 `runs_list.runs[]` 同形的条目（含 `activityStatus`/`activityBasis` 的诚实语义与 `unresolvedCount` 事实，另带 `returnedCount`/`truncated`）；不请求就没有这个键、不多扫描。项目范围与原工具一致（`expectedWorkspaceRoot` 当场证明，缺省按 MCP roots → 启动配置）；复用 `runList.js` 同一服务，不复制。该节不进 `checkStatus`、不影响 `complete`。CLI `wao runs list` 不动。
4. **`run_delivery_review_bundle` → 删除**。它是 `run_delivery`（带 `waitMs` 的一次等待）加 `run_delivery_review`（一页审查）的组合，两次调用就是等价物；指向它的地方（SKILL 闭环、nextStep、availableDrilldowns、语义目录、手册）改指这两个原子工具。
5. 破坏性变更，下次发版升 MINOR（决定 0109）。工具列表、描述、宿主可见三条字节天花板按实测下调重冻（见 0021 追加记录）；宿主重启 MCP 服务后生效。

## 不采纳

- **给 `run_dispatch` 加 `checkOnly`**（保留"只预检不派发"的独立入口）：它会让一个标为破坏性的工具承担只读调用，回执形状也要变成两种。删前能做而删后做不到的只剩"只预检不派发"；它的用途（派发前发现合同问题）由"拒绝照旧在派发前 + 提醒在回执里当场给出"覆盖。
- **保留 `registry_list`/`runs_list` 作薄壳**（转发到 preflight）：留桩只会让两套说法并存更久（同 0125 的过渡桩裁定）。
- **把 `unresolvedCount` 等运行事实复制进默认 preflight 输出**：recentRuns 保持按需——不请求零额外扫描，默认载荷不膨胀。

## 影响

- 调用已删的四个工具，宿主报未知工具；SKILL 与手册已同批改好。`lead_preflight` 的 workers 条目形状变宽（additive 字段），输入多两个可选成员（additive）。
- 预检随派发就地运行后，每个 `run_dispatch` 调用多一次只读预检查（读注册表 + 按调用目标 stat 探针；无副作用）。预检自身意外失败按 advisory 缺席处理，不拦派发。
- 原 `runs_list` 的"未绑定固定错误"语义随工具消亡：preflight 对未绑定如实报 `workspace.bound:false` + `recentRuns:null`（不跨项目、不伪造空清单）。原 `registry_list` 的"整源不可读整次 isError"改为 preflight 的 `workers:null` + `checkStatus.workers:"unknown"`（分节独立结算；两者都不伪造成空清单成功）。
- CLI 面零改动（`registry list` / `runs list` / 无预检入口照旧）。
