// scripts/reliability/metricsCheck.mjs
//
// TD-87 认证面症状解除（2026-08-20，Owner 批准）：metricsNonZero 检查能力化。
// ADR-0032 §8（2026-09-21 落地）：不适用改记五态 not-applicable（带原因），
// 不再以 pass:true + capability:"metrics" 伪装能力绿。
//
// 背景：reliability 认证的 metricsNonZero 检查（observability 类目）断言 run
// metrics 的 input token 非空。kimi-code 的 stream-json 无 usage 字段（TD-87），
// 导致 coder_mm 每一轮都因此落 conditional、lastHealthyRunAt 永远 null、严格门
// 永久拒绝——测的是一个已知的 backend 静态属性，不是组合质量。
//
// 语义（Owner 裁定 2026-08-20 + ADR-0032 §8 五态化 2026-09-21）：
//   - 判定源是 ADR-0025 批次 2 的 backendCapabilitySnapshot SSOT
//     （src/backends/factory.js，构造零副作用），本模块只消费、不第二套判定。
//   - 声明 reportsTokenUsage !== true 的 lane：检查记 not-applicable + 原因
//     （能力缺口事实由批次 2 声明与 registry validate 交叉警告独立承载）。
//     N/A 满足 observability 必需类目的【覆盖】（检查跑了、如实话不适用——
//     TD-87 症状解除保留），但【不贡献能力绿】：certifyCase 的 capabilities
//     聚合对 N/A 检查跳过，capabilities.metrics 不再被置 true。
//   - 声明 reportsTokenUsage === true 的 lane：原非空断言不变（金丝雀保留——
//     流格式变化致 metrics 投影断裂时第一时间红）。
//
// 纯模块：零 I/O；唯一外部依赖是静态能力读取（backendCapabilitySnapshot）。
// 真实 token 消耗的派发留在 scripts/run-reliability.mjs 的 drill glue。

import { backendCapabilitySnapshot } from "../../src/backends/factory.js";
import { naCheck } from "./checkStates.mjs";

/**
 * metricsNonZero 检查判定：backend 能力声明 × run metrics input → observability
 * check（与 run-reliability.mjs 的 check() 形状一致：
 * {name, pass, category, detail, capability}；不适用形状另带
 * state/stateReason——ADR-0032 §8 五态）。
 *
 * @param {object} input
 * @param {object|null} [input.agent] — registry 原始条目（只读 agent.backend；
 *   backendCapabilitySnapshot 经无副作用构造读类声明）
 * @param {number|null} [input.metricsInput] — run metrics 的 input token
 *   （result.metrics.tokens.input，缺失为 null）
 * @param {object|null} [input.capabilitySnapshot] — 测试注入的能力快照形状；未注入
 *   时经 SSOT 从 agent 派生
 * @returns {{name: string, pass: boolean, category: string, detail: string, capability: string,
 *   state?: string, stateReason?: string}}
 */
export function metricsNonZeroCheck({ agent = null, metricsInput = null, capabilitySnapshot = null } = {}) {
  const snapshot = capabilitySnapshot ?? (agent !== null ? backendCapabilitySnapshot(agent) : null);
  if (snapshot?.reportsTokenUsage !== true) {
    // N/A ≠ 可选检查 ≠ 能力绿：检查如实录 not-applicable + 原因；覆盖 observability
    // 必需类目（不重现 TD-87 的 conditional 症状），能力轴不置绿（ADR-0032 §8）。
    const declared = snapshot ? String(snapshot.reportsTokenUsage) : "unknown";
    return naCheck(
      "metricsNonZero",
      `backend declares reportsTokenUsage=${declared} (TD-87 capability declaration) — the metrics axis is not asserted for this lane; input=${metricsInput ?? null}`,
      "observability",
      { capability: "metrics" },
    );
  }
  return {
    name: "metricsNonZero",
    pass: (metricsInput ?? 0) > 0,
    category: "observability",
    detail: `input=${metricsInput}`,
    capability: "metrics",
  };
}
