// src/application/backendCliMap.js
//
// backend → CLI 探测映射的唯一权威表（BACKEND_CLI SSOT）。
//
// R6-C3（P2-4，席位 A）：此前 src/commands/doctor.js（自称"权威表"）与
// src/application/onboarding.js 各持一份逐字重复的本地表，且都漏了活 backend
// deepseek-harness（src/backends/factory.js 有实例）——两份重复表必然漂移。
// 收敛为单一来源，两个消费方都 import 本模块。分层方向：commands →
// application 合法，不反向。
//
// 值语义：
//   string = 该 backend 依赖的 PATH CLI 名（doctor/onboarding 用 where/which 探测）；
//   null   = 该 backend 无独立 CLI 可探（见下方 deepseek-harness 注释）。
// 调用方对 null 与未列出的 backend 同样按"无法映射"处理（doctor WARN 不静默；
// onboarding requiresCli=null ⇒ readyState unknown）——不假装已覆盖。例外：
// BACKEND_OWN_READINESS 在册者由 doctor 的自有检查覆盖，不按"无法映射"处理。

/** backend → CLI 探测名（null = 无独立 CLI，按"无法映射"语义处理）。 */
export const BACKEND_CLI = {
  "claude-code": "claude",
  codex: "codex",
  "kimi-code": "kimi",
  "opencode-serve": "opencode",
  // JSON-RPC 适配器 backend（src/backends/factory.js 的活分支）：进程由 harness
  // 自管，不依赖 PATH 上的独立 CLI，无物可探——显式置 null 而非缺省。
  "deepseek-harness": null,
  // ADR-0031：ACP 线直接驱动上游 `dsh` CLI（--profile acp）——CLI 可探；
  // 注意 CLI 在场 ≠ 就绪：还需操作员安装 containment 覆盖层（docs/certification-runbook.md）。
  "deepseek-acp": "dsh",
};

/**
 * 没有 PATH CLI、但 doctor 用自己的检查覆盖就绪的 backend（冻结表）。
 *
 * 为什么这些 backend 不进 BACKEND_CLI：那张表的 null 语义是"无法映射"（doctor 出
 * backend_map_<id> WARN；onboarding requiresCli=null ⇒ readyState unknown；wao lanes
 * 也读它）——zcode/kimi-web 并非"无法覆盖"，塞进 null 语义会把消费方一起改坏。
 * 值是覆盖方式的自描述标签（消费方只判"在不在表里"，不按值分支）：
 *   - "binary_path"：zcode 无 PATH CLI，就绪 = registry binary 字段指向桌面捆绑
 *     zcode.cjs 的真实文件（doctor 出 zcode_binary_<id>，缺文件即 FAIL；承重 env
 *     另有 5b 段检查）；
 *   - "serve_and_token"：kimi-web 是本地 HTTP serve，不是 CLI——凭据走 token 文件
 *     与 key 检查（kimi_token_file_<id>、key_*），serve 可达性由派发时探测（声明
 *     serveWorkspaceDir 会自动拉起，wao lanes 显示就绪态）。
 *
 * doctor 的自有检查只覆盖配置期能判定的项，不证明运行期就绪：zcode 只证明 binary
 * 文件存在，不证明它是桌面捆绑的 zcode.cjs，也不证明登录态；kimi-web 只查 token
 * 与 key，serve 可达性由派发时证明。
 */
export const BACKEND_OWN_READINESS = Object.freeze({
  "zcode": "binary_path",
  "kimi-web": "serve_and_token",
});
