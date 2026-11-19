# 0125 MCP 工具面 23 → 20：删除共享项目选择（L2），撤出 `workspace_status` 与 `run_wait`（L1）

- 日期：2026-11-19
- 状态：accepted
- 来源：
  - 11-19 WAO 与宿主内建 subagent 对比，fable 会审 `consult_202611191305174990c0k7s`：按调用带根的读工具（第 118 批）落地后，共享选择只剩负债。
  - Owner 2026-11-19："收掉两个多余的工具 —— 不要等，该做就做。"
  - 方案会审 `consult_202611191333556054m2sij`（sol、kimi），交付会审 `consult_20261119161554348waj4i6`（sol、deepseek-flash、kimi）。
  - 第 119 批。
- 关系：按决定 0021 第 4 条减面两级执行，并在 0021 追加记录；收尾 0021 的 2026-10-15 追加记录（会动工作区的工具必传目标）留下的共享选择；MCP 等待入口补充决定 0095。

## 背景

一个 MCP 服务实例同时服务多个宿主会话（决定 0120 背景）。`workspace_select` 把选择存在实例上，A 会话选了项目 X，B 会话读工具的缺省范围就跟着变。10-15 起写类调用必传目标，第 118 批起读工具可选带目标，共享选择只剩串扰。11-19 盘点：`workspace_select` 被调过 26 次；MCP `run_wait` 37 次，同期 CLI `runs wait` 约 557 次。

## 决定

1. **删除共享选择（L2）**：MCP `workspace_select` 与 `lead_session` 绑定来源一起删除。`resolveWorkspaceBinding()` 只剩 MCP roots → 启动配置 → 未绑定。凡涉及项目的调用按调用带 `expectedWorkspaceRoot`。
2. **`workspace_status` 撤出（L1）**：它独有的规范化绝对根，改由 `lead_preflight.workspace.workspaceRoot` 给出。
   - `lead_preflight` 的输入改名 `expectedWorkspaceRoot`，每次调用当场证明，不留状态。
   - 证明失败时不给项目内容。
   - `readOnlyHint` 改为 true。
   - `run_status`、`run_diagnose` 加可选的 `expectedWorkspaceRoot`。
3. **MCP `run_wait` 撤出（L1）**：MCP 面反复调 `run_await_result`（单次 ≤270 秒）到终态；终态而交付还在打包或验证时，它的 `availableDrilldowns` 指向 `run_delivery`，带 `waitMs` 等收口；要一直挂到收口，用 CLI `runs wait --until-settled`（决定 0095）。CLI 等待服务、语义目录键 `run_wait` 与 CLI nextStep 不动。
4. 破坏性变更，版本升 v0.10.0（决定 0109）。三条描述字节线按实测下调重冻。

## 不采纳

- **保留 `workspace_status` 并给它加目标参数，停在 21 个工具**（kimi 方案会审）：它独有的只是规范化绝对根，放进 preflight 只多一个字段。Lead 每个会话本来就先调 preflight，它的其余扫描也都是只读的。
- **把共享选择降为提示，而不删除**：只要留着实例级状态，就留着跨会话串扰的口子；按调用带根已覆盖它的全部用途。
- **为旧工具名留过渡桩**：调用旧工具，宿主会报未知工具；SKILL 与手册已同批改好。留桩只会让两套说法并存更久。

## 影响

- 调用已删的工具，宿主报未知工具。`lead_preflight` 的旧参数名 `workspaceRoot` 被 strict schema 拒绝。宿主重启 MCP 服务后才加载新代码，可看 `lead_preflight` 的 server build 行确认。
- `mcp bind`/`mcp status`、doctor、Owner 看板不依赖共享选择，不受影响。
