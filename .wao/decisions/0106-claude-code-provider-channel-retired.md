# 0106 claude-code 的 provider 通道退役

- 日期：2026-11-01
- 状态：accepted
- 来源：Owner 2026-11-01 回复"批准你的两个请示"（Lead 按 0105 同一理由——原厂 harness 驱动原厂 LLM——提请退役 provider 通道；0105 的 Owner 原话见该决定）

## 背景

provider 通道是 claude-code 驱动非 Anthropic 模型的路径：registry 条目的 `provider` 块（anthropic-compatible 的 `baseUrl` + `apiKeyEnv`）经 `scripts/wrappers/claude-code-provider-wrapper.mjs` 改写 claude CLI 的连接。现行 8 条车道没有一条用它（本机 registry 里没有 provider 块）。opencode worker 后端已按同一理由退役（决定 0105）。

## 决定

1. 代码、测试、文档移出工作树：`src/backends/claudeCodeProvider.js`、wrapper 脚本、`src/providerFingerprint.js` 及其专属测试一并删除。
2. annotated tag `archive/claude-code-provider-channel` 指向 dafa257，即退役前最后一个含 provider 通道的 main 提交。取回用 `git checkout archive/claude-code-provider-channel -- <路径>`；取回后须把测试一并恢复并重新认证。
3. registry 统一拒绝 provider 块：`normalizeModelPolicy` 对任何 backend 的非 null provider 块抛固定文案；各 backend `validateAgentPolicy` 里的 provider 拒绝分支与能力说明（CAPABILITY_NOTES 的 `provider` 键、生成层 provider 列）随之删除。
4. providerKey 维度（认证身份四元组第 4 维）字段保留、恒为 null：写入侧继续写显式 `null`（缺字段会触发 legacy 台账提示）；读取侧继续接受字符串或 null（磁盘上的旧记录）。记录侧带非空 providerKey 的旧认证从此不再匹配任何车道。
5. claude-code 只剩 native OAuth 通道；`model.contextWindow` 一律拒绝（无 CLI 参数可表达）。

## 被否方案

- 留作休眠通道：没有车道用，代码、wrapper、指纹归一化与全套契约测试都得养着，纯成本。
- 删掉 providerKey 维：会改全部车道的身份指纹，8 条车道的认证全部失效，要逐条重新认证。
- 各 backend 各自保留 provider 拒绝：同一条规则写七遍（registry 一处拒绝即覆盖全部入口）。

## 已知局限

- registry 里写了 provider 块的条目现在载入即报错（固定文案指路删除该块）。
- 记录侧带非空 providerKey 的旧认证不再匹配；这些车道要重跑 reliability 认证。
- 取回不是单文件即用：要连测试一起恢复并重新认证。
- 决定、事故、changelog 里的 provider 历史照原样保留。
