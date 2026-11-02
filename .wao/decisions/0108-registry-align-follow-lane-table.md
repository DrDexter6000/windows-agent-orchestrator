# 0108 私有注册表跟随车道表：registry align 逐车道显式采用

- 日期：2026-11-02
- 状态：accepted
- 来源：Owner 2026-11-02 同意（sol、kimi 头脑风暴 consult_20261102065625413h7476g）。
- 关系：承接 0045（G4 注册表赢、lane_wiring_mismatch 即拒）与 0044。0044 否决的是把"镜像义务"机械化——模板改了私有副本就得自动跟着改；本决定不碰那个边界：这里是用户主动修自己的副本，模板与私有副本长期滞后仍然合法（私有注册表本来就是按可用认证删减过的模板，不是镜像）。

## 背景

升级后模板与 `config/lanes.json` 换了型号或 effort，私有 `config/agents.json` 还是旧接线，`--lane` 派发就以 `lane_wiring_mismatch` 拒绝。旧的拒绝文案只说"请对齐 lanes.json"——方向反了：车道表是 git 跟踪的权威断言面，要修的是私有副本；而且用户拿到拒绝时既看不出差在哪，也没有安全的修法（手改 JSON 要自己记得备份、同步认证矩阵行）。

## 决定

1. **逐车道显式采用，不做通用合并**。没有合并基线：WAO 分不清用户有意的改动和模板的更新。所以默认只读（预览零写入、给 SHA-256）；写入只限用户点名的车道（`--lane`，可重复，没有"一键全修"）、且必须带与当前文件一致的 `--expect-sha256`（防预览后文件又变）。
2. **只改接线**：所选车道只把四轴（backend、model.id、model.providerID、reasoning.effort）改成车道表的值，同名认证矩阵行只改 `modelId`；`label`、`profile`、`drills`、`_comment*` 与全部本地字段（cwd、env、binary、args、kimiHome、serveWorkspaceDir 等）不动。车道表侧为 null 的轴键从文件里删除，不留占位 null。
3. **写前护栏**：原文件逐字节备份到同目录 `agents.json.bak-<UTC时间戳>`（`.gitignore` 已忽略该模式；同名已存在就换名，不覆盖），再原子替换（`src/atomicWriteSync.js`）。整次拒绝、什么都不写的条件：`--apply` 缺 `--lane` 或哈希不符；所选车道不在车道表、不在私有注册表；车道表与模板（`config/agents.example.json`，第二见证）在该车道接线轴上不一致（仓库自身冲突）；改后过不了现有校验；文件整份重写会改变某个值的写法（如 `1e400`、`1.0`、重复键——align 只能整份重写，宁可拒绝也不动未点名的条目）。
4. **诊断三类事实**（预览、doctor、lead_preflight 共用同一份实现 `src/application/registryAlign.js`，轴比较复用 `dispatchResolution.js` 的 `laneAxes`/`agentAxes`/`axesEqual`）：配置不合法（过不了现有校验，含已退役 provider 块）；接线与车道表不一致（逐轴列差值；认证影响两类——backend/model.id/providerID 变=换身份，旧认证不再适用，只差 effort=身份不变、按 runbook「lane 变更同步面」④ delta 重取证；同名矩阵行 modelId 滞后也列出）；与车道表不同但合法（表有私无=可添加不自动加；私有有表无=车道表已不再提供，默认保留）。
5. **提示面（共用诊断，都不拦截）**：doctor 新增 `lane_wiring` 检查项（接线不一致 WARN + 预览命令；只有合法差异 INFO）；`lead_preflight` 只在现有 `observations` 里加一行事实（worker 上下文不投影）；`lane_wiring_mismatch` 拒绝文案改两条路——升级后副本落后跑 `registry align`，有意改车道按 runbook「lane 变更同步面」同改。

## 否决的备选

- **通用模板合并器**（三方合并/自动 diff-apply）：没有合并基线，自动采纳会把用户有意的本地改动静默冲掉；每次升级都要回答"谁的意图算数"，WAO 答不了。
- **私有文件改成只写本地差异的覆盖层**（template + overlay 两文件）：根治了漂移问题，但改动的是注册表的存储模型——所有读面、校验面、用户心智、文档都要跟着翻，与本批"给升级一个安全的修法"不成比例；留作将来单独立项。
- **只修文案加提示**（不改命令）：用户仍然要手改 JSON 并记得备份与矩阵行同步——错误面原样保留，提示只是把工作搬回用户脑子里。

## 已知边界

- 不自动增删车道、不做整套改名、不做通用合并（`wao onboarding` 的 ·drift 展示照旧，TD-330 不在本批）。
- `registry align` 不验证认证状态本身：它只修接线与矩阵行 `modelId`；换身份后的重取证由 runbook 的认证规程管。
- `--registry` 指向别的文件时 align 照常工作（它的目的就是修点名的那份注册表），但车道表恒为本仓库的 `config/lanes.json`——不提供 `--lanes-file`（防跨绑纪律在 run/派发侧，align 是修副本的桥）。
