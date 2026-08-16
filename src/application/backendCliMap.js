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
// onboarding requiresCli=null ⇒ readyState unknown）——不假装已覆盖。

/** backend → CLI 探测名（null = 无独立 CLI，按"无法映射"语义处理）。 */
export const BACKEND_CLI = {
  "claude-code": "claude",
  codex: "codex",
  "kimi-code": "kimi",
  "opencode-serve": "opencode",
  // JSON-RPC 适配器 backend（src/backends/factory.js 的活分支）：进程由 harness
  // 自管，不依赖 PATH 上的独立 CLI，无物可探——显式置 null 而非缺省。
  "deepseek-harness": null,
};
