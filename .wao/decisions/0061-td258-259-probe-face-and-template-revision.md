# 0061 — TD-258/259 批：onboarding 凭据探测面扩展（key_only 两态）+ 模板两缺陷改版

## 背景

Owner 2026-10-11 晚指令：①追认 TD-257 批只读 run 分支删除（已入 0060 修订节）；②TD-258/259 "如果 opus 和 sol 同意、按照你们的综合意见来推进"。方案会审 consult_20261011195603814pa7g5f（opus+sol 双席）：TD-258 两席在"是否新增 readyState 状态"上分歧（opus 反对·主因分叉与夸大语义；sol 支持但强制共用推导+全消费面覆盖+不抬席级），Lead 综合裁定=采 sol 骨架 + opus 全部安全条款；TD-259 两席一致同意（Owner 条件授权=两席同意即构成模板蓄意事件批准）。

## 决定

1. **readyState 闭集六态→八态**（panelReadiness.deriveReadyState 单一实现，onboarding+doctor 双面消费）：新增 `key_only_present` / `key_only_missing`——无 CLI 探测面（kimi-web=serve 通道）但声明凭据名的车道，只探 key 名可解析性。**语义收窄**：key 名可解析≠就绪（未验证令牌有效性/serve 可达性/运行时可用性），命名不带 ready 防夸大。无凭据声明的无 CLI 车道（zcode：承重 env 桥不是凭据）恒 unknown。两态**不计可用席位、不抬 panel tier、不无声消失**（assessPanelReadiness 新增 keyOnly 桶，双面渲染各有展示行）。
2. **凭据名权威统一**：onboarding 推荐矩阵的 requiresKeyEnv 改从 `requiredCredentialNames` 派生（doctor 同一权威，覆盖 provider.apiKeyEnv/tokenEnv/credentialEnv 三类），消费全部声明名；多名聚合成单一 key 态走新共享函数 `aggregateCredentialSources`（credentialReadiness.js，doctor 内联逻辑收编）。每个探测源先 normalizeKey 再聚合（原始 null=missing，防聚合层吞形状——实施中被测试抓住后修）。
3. **模板蓄意改版（决定 0044/0046 事件，Owner 经本轮指令+双席同意授权）**：①glm-flash 补 zcode 承重 env 桥（与 glm-pro 同款占位样式）；两车道注释均加反向警告——agent-env 先于 User 作用域解析，ZCode 桌面已写 User 变量时须删整个 env 块，原样保留占位值会盖掉有效配置=spawn 必死（doctor 5b 报 file-missing）。②kimi serveUrl 58627→58628：与 usage 场景 4e worker serve 配方一致；原 58627 是 `kimi web` CLI 裸默认（人用主 serve），照抄会让 0047 env 臂静默失效——改 58628 后误配=连接被拒大声失败。
4. **端口守卫原则修订**（docs-consistency PORT_BY_FILE）：面向用户文档写**通道配方的 worker 端口**（kimi-web=58628，opencode=4297 不变），本机真实端口仍属配置私事。
5. **KIMI_WEB_TOKEN 补档**（usage 场景 4e 新节）：token=`kimi web` serve 签发的持久 Bearer（上游 `--help`：启动打印；`rotate-token` 轮换且旧 token 立即失效——共用主目录的 serve 连坐）；注入=setx User 作用域，**派发链不要求新终端**（TD-208 实证 env→HKCU 回退；需新终端的只有直接读进程 env 的工具）；Git Bash 引号纪律指针到 runbook。**未验证边界如实标注**：loopback 启动是否恒打印、KIMI_CODE_HOME 分家后 token 是否独立。

## 边界与欠账

- TD-258 收窄保留：令牌获取的可照做步骤仍缺本仓验证（上游 help 已证部分事实）；deepseek-acp 报 ready 继承 doctor 既有的"CLI 在场≠就绪"夸大（ADR-0031 containment 覆盖层不在探测面——非本批引入）。
- dogfood 证据：裸跑 onboarding 双面（kimi=key_only_present+tokenEnv 名、deepseek=ready 与 doctor 同态、zcode=无 CLI 探测面新标签）；模板单车道 registry（glm-flash+kimi）validate 全过 + doctor 5b 对 glm-flash 占位桥响亮报 file-missing + keyOnly 展示行在面板活现。

## 核验补记（2026-10-11 晚，Owner 点名收窄尾，真机实证）

- **loopback/无 TTY 启动不打印 token**：worker 主目录一次性 serve（端口 58631，stdout/stderr 双重定向）输出双空——上游 `--help` 的"printed at startup"仅适用于交互式控制台。**替代获取配方实证**：token 持久化于 `<kimi 主目录>/server.token`（43 字符），文件内值即活体凭据（以之调 `/api/v1/meta` 得 200）；跨启动与优雅 shutdown 均不变（sha8 三采样一致）。
- **token 按主目录隔离**：owner 家（6a53d7ca）与 worker 家（4a186739）server.token 哈希不同——`KIMI_CODE_HOME` 分家后各 serve 令牌独立；`rotate-token` 爆炸半径=同一主目录内的全部 serve。
- 试验卫生：一次性 serve 经优雅 `POST /api/v1/shutdown` 拆除（200 ok；端口 LISTENING 清零、pid 离场、TIME_WAIT 自然收尾）；全程未运行 rotate-token、未回显任何 token 值、未触碰 Owner 主 serve。usage.md 场景 4e 的 KIMI_WEB_TOKEN 节已替换为实证版；TD-258 据此关账。
