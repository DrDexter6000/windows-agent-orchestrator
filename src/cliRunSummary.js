// src/cliRunSummary.js
//
// P4 融合项 #1（决策A）：run 命令的人类可读摘要渲染。
//
// 决策 0010：让 run 成为唯一需要的命令——它已返回一切，但默认静默阻塞末尾 dump JSON。
// 改成默认打印 header（runId · agent · 结果 · 成本）+ 内联 scorecard 卡片，一次融合取代
// collect/scorecard/metrics 的常见回查。详细 JSON 走 --format json（向后兼容，脚本/agent 用）。
//
// 纯函数 renderRunSummary(waitResult, {agentId})：不 spawn、不读文件，只格式化已聚合的结果。
// 与 metrics.js 的 formatDuration 同款时长格式（保持 CLI 一致）。

import { formatDuration } from "./metrics.js";

/**
 * 把一个 run 的 waitResult 渲染成人类可读摘要（决策A header + scorecard 卡片）。
 * @param {object} waitResult - runAndWait / waitForCompletion 的返回（含 runId/completed/metrics/scorecard?）
 * @param {{agentId?: string}} [meta]
 * @returns {string} 多行人类可读文本
 */
export function renderRunSummary(waitResult, meta = {}) {
  const r = waitResult ?? {};
  const agentId = meta.agentId ?? "(unknown agent)";
  const lines = [];

  // 结果判定（与 state 一致的措辞）
  const result = r.failed ? "FAILED"
    : r.timedOut ? "TIMED OUT"
    : r.budgetExceeded ? "BUDGET EXCEEDED"
    : r.completed ? "completed"
    : "unknown";

  // header 行：runId · agent · 结果 · 成本
  lines.push(`# ${r.runId ?? "(no runId)"}  [${agentId}]  ${result}`);

  // 成本/时长（metrics 可能缺失，缺则省略）
  const m = r.metrics;
  if (m) {
    const bits = [];
    if (typeof m.durationMs === "number") bits.push(`duration ${formatDuration(m.durationMs)}`);
    if (typeof m.costUsd === "number") bits.push(`cost $${m.costUsd.toFixed(4)}`);
    const t = m.tokens;
    if (t && Object.keys(t).length > 0) {
      bits.push(`tokens in=${t.input ?? 0} out=${t.output ?? 0} reasoning=${t.reasoning ?? 0}`);
    }
    if (bits.length > 0) lines.push(`  ${bits.join("  ·  ")}`);
  }

  // 失败详情
  if (r.error) {
    lines.push(`  error: ${r.error}`);
  }

  // 内联 scorecard 卡片（opt-in：有 scorecard 结果才显示）
  if (r.scorecard) {
    const verdict = r.scorecard.passed ? "PASS" : "FAIL";
    lines.push("");
    lines.push(`scorecard: ${verdict}`);
    for (const c of r.scorecard.checks ?? []) {
      const mark = c.passed ? "✓" : "✗";
      const detail = c.passed ? "" : `  — ${c.detail ?? "failed"}`;
      lines.push(`  ${mark} ${c.name}${detail}`);
    }
  }

  return lines.join("\n");
}
